// Fork route tests: POST /api/runs/:id/fork creates the fork and launches a
// fake agent, which calls back through the LLM proxy to a fake upstream.
// Postgres must be up. Every run they create is named 'fork-test...'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { createRun, setRunStatus } from '../src/runs.js';
import { startStep, finishStep } from '../src/steps.js';

const TEST_NAME = 'fork-test';
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.js', import.meta.url));

// Fake upstream: echoes the last user message back as the reply.
const upstream = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo: ${messages.at(-1).content}` } }] }));
});

let server;
let baseUrl;

const listen = async (srv) => {
  srv.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  return `http://localhost:${srv.address().port}`;
};

before(async () => {
  await migrate();
  const upstreamUrl = await listen(upstream);
  // The server must know its own URL to hand it to forked agents, and the
  // port is only known after listening, so the app is attached afterwards.
  server = http.createServer();
  baseUrl = await listen(server);
  server.on('request', createApp({ upstreamUrl, serverUrl: baseUrl }));
});

after(async () => {
  await pool.query("DELETE FROM runs WHERE name LIKE 'fork-test%' AND parent_run_id IS NOT NULL");
  await pool.query("DELETE FROM runs WHERE name LIKE 'fork-test%'");
  server.close();
  upstream.close();
  await pool.end();
});

const ask = (text) => ({ model: 'fake', messages: [{ role: 'user', content: text }] });
const answer = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }] });

// A finished parent whose agent is the fake agent. `texts` are the LLM
// calls it made, each recorded with the answer "parent: <text>".
async function recordParent(agentArgs, texts, status = 'success') {
  const run = await createRun({ name: TEST_NAME, command: [process.execPath, FAKE_AGENT, ...agentArgs], cwd: process.cwd() });
  for (const text of texts) {
    const { idx } = await startStep(run.id, { type: 'llm', request: ask(text) });
    await finishStep(run.id, idx, { response: answer(`parent: ${text}`) });
  }
  if (status !== 'running') await setRunStatus(run.id, status);
  return run;
}

async function postFork(parentId, body) {
  const res = await fetch(`${baseUrl}/api/runs/${parentId}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The agent runs in the background: poll until the run has a final status.
async function waitForEnd(runId) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query('SELECT status FROM runs WHERE id = $1', [runId]);
    if (rows[0].status !== 'running') return rows[0].status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} is still running`);
}

async function stepsOf(runId) {
  const { rows } = await pool.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY idx', [runId]);
  return rows;
}

const forkCount = async (parentId) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM runs WHERE parent_run_id = $1', [parentId])).rows[0].n;

test('a fork replays the parent, applies the override, and launches the agent', async () => {
  const parent = await recordParent(['calls', 'hi', 'more'], ['hi', 'more']);
  const res = await postFork(parent.id, {
    fork_step: 1,
    fork_override: { kind: 'request', request: ask('edited') },
  });
  assert.equal(res.status, 201);
  const fork = res.body;
  assert.equal(fork.status, 'running');
  assert.equal(fork.parent_run_id, parent.id);
  assert.equal(fork.fork_step, 1);
  assert.equal(fork.name, 'fork-test (fork at step 1)');
  assert.deepEqual(fork.command, parent.command);
  assert.equal(fork.cwd, parent.cwd);

  assert.equal(await waitForEnd(fork.id), 'success');
  const steps = await stepsOf(fork.id);
  assert.equal(steps.length, 2);
  // Step 0 came from the parent; step 1 sent the edited request live.
  assert.equal(steps[0].replayed, true);
  assert.deepEqual(steps[0].response, answer('parent: hi'));
  assert.equal(steps[1].replayed, false);
  assert.deepEqual(steps[1].request, ask('edited'));
  assert.equal(steps[1].response.choices[0].message.content, 'echo: edited');
});

test('a fork with no override replays, then goes live, and keeps a given name', async () => {
  const parent = await recordParent(['calls', 'hi', 'more'], ['hi', 'more']);
  const res = await postFork(parent.id, { fork_step: 1, name: 'fork-test named' });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'fork-test named');
  assert.equal(await waitForEnd(res.body.id), 'success');
  const steps = await stepsOf(res.body.id);
  assert.deepEqual(steps.map((s) => s.replayed), [true, false]);
  assert.equal(steps[1].response.choices[0].message.content, 'echo: more');
});

test('an agent that exits non-zero marks the fork failed', async () => {
  const parent = await recordParent(['exit', '2'], ['hi'], 'failed');
  const res = await postFork(parent.id, { fork_step: 0 });
  assert.equal(await waitForEnd(res.body.id), 'failed');
});

test('setup runs before the agent', async () => {
  const marker = path.join(os.tmpdir(), `rewind-fork-test-${process.pid}-${Date.now()}`);
  try {
    // The agent exits 1 unless the marker file exists, so success means setup ran first.
    const parent = await recordParent(['require', marker], ['hi']);
    const setup = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
    const res = await postFork(parent.id, { fork_step: 0, setup });
    assert.equal(res.status, 201);
    assert.equal(await waitForEnd(res.body.id), 'success');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('a failing setup marks the fork failed and never starts the agent', async () => {
  const parent = await recordParent(['calls', 'hi'], ['hi']);
  const res = await postFork(parent.id, { fork_step: 0, setup: [process.execPath, '-e', 'process.exit(3)'] });
  assert.equal(await waitForEnd(res.body.id), 'failed');
  assert.equal((await stepsOf(res.body.id)).length, 0);
});

test('bad fork requests are refused and create no run', async () => {
  const parent = await recordParent(['calls', 'hi'], ['hi', 'more']);
  const cases = [
    [{}, 400], // no fork_step
    [{ fork_step: 2 }, 400], // past the last step
    [{ fork_step: -1 }, 400],
    [{ fork_step: '1' }, 400],
    [{ fork_step: 0, fork_override: { kind: 'model' } }, 400],
    [{ fork_step: 0, setup: 'npm run seed' }, 400],
    [{ fork_step: 0, setup: [] }, 400],
    [{ fork_step: 0, name: 7 }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await postFork(parent.id, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal(await forkCount(parent.id), 0);
});

test('forking a missing run is a 404, and a running or empty run is refused', async () => {
  assert.equal((await postFork('00000000-0000-0000-0000-000000000000', { fork_step: 0 })).status, 404);
  assert.equal((await postFork('not-a-uuid', { fork_step: 0 })).status, 400);

  const running = await recordParent(['calls', 'hi'], ['hi'], 'running');
  assert.equal((await postFork(running.id, { fork_step: 0 })).status, 409);

  const empty = await recordParent(['calls'], []);
  assert.equal((await postFork(empty.id, { fork_step: 0 })).status, 400);
});
