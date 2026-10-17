// Eval run tests: POST /api/evals/:id/runs launches the fake agent, which
// calls a fake upstream through the LLM proxy; the server then checks the
// assertions. Also `rewind eval`, which needs a server that can launch
// agents. Postgres must be up. Runs are named 'eval-test ...' or
// '[eval] eval-test ...'; their evals are deleted by id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { createRun, setRunStatus } from '../src/runs.js';
import { createEval } from '../src/evals.js';
import { parseEvalArgs } from '../src/evalCommand.js';

const BIN = fileURLToPath(new URL('../bin/rewind.js', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.js', import.meta.url));
const evalIds = [];

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
  // As in fork.test.js: the app needs its own URL to hand to launched agents.
  server = http.createServer();
  baseUrl = await listen(server);
  server.on('request', createApp({ upstreamUrl, serverUrl: baseUrl }));
});

after(async () => {
  await pool.query('DELETE FROM evals WHERE id = ANY($1::uuid[])', [evalIds]);
  await pool.query("DELETE FROM runs WHERE name LIKE '%eval-test%'");
  server.close();
  upstream.close();
  await pool.end();
});

async function call(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// An eval whose agent is the fake agent with `agentArgs`.
async function newEval(agentArgs, assertions, setup = null) {
  const source = await createRun({ name: 'eval-test source', command: [process.execPath, FAKE_AGENT, ...agentArgs], cwd: process.cwd() });
  await setRunStatus(source.id, 'success');
  const ev = await createEval({ sourceRunId: source.id, inputTask: `eval-test ${agentArgs.join(' ')}`, assertions, setup });
  evalIds.push(ev.id);
  return ev;
}

// Polls until the result has a verdict.
async function waitForVerdict(evalId, resultId) {
  for (let i = 0; i < 100; i++) {
    const { body } = await call('GET', `/api/evals/${evalId}`);
    const result = body.results.find((r) => r.id === resultId);
    if (result.passed !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no verdict');
}

const passing = [
  { type: 'run_status', status: 'success' },
  { type: 'max_steps', max: 1 },
  { type: 'final_output_contains', text: 'ECHO: hello' },
];

test('an eval run starts unchecked, then passes when its assertions hold', async () => {
  const ev = await newEval(['calls', 'hello'], passing);
  const res = await call('POST', `/api/evals/${ev.id}/runs`);
  assert.equal(res.status, 201);
  const { run, result } = res.body;
  assert.equal(result.passed, null);
  assert.equal(result.run_id, run.id);
  // A fresh live run of the eval's command, not a fork.
  assert.equal(run.parent_run_id, null);
  assert.equal(run.name, '[eval] eval-test calls hello');
  assert.deepEqual(run.command, ev.command);

  const checked = await waitForVerdict(ev.id, result.id);
  assert.equal(checked.passed, true);
  assert.deepEqual(checked.failures, []);
  assert.equal(checked.run_status, 'success');
});

test('a failing agent gives passed false with the reasons', async () => {
  const ev = await newEval(['exit', '1'], passing);
  const { body } = await call('POST', `/api/evals/${ev.id}/runs`);
  const checked = await waitForVerdict(ev.id, body.result.id);
  assert.equal(checked.passed, false);
  assert.deepEqual(checked.failures.map((f) => f.message), [
    'run status was failed, expected success',
    'final output doesn\'t contain "ECHO: hello"',
  ]);
  assert.deepEqual(checked.failures.map((f) => f.index), [0, 2]);
});

test("an eval's setup runs before its agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-eval-'));
  const marker = path.join(dir, 'seeded');
  try {
    // The agent exits 1 unless the marker exists, so a pass means setup ran first.
    const setup = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
    const ev = await newEval(['require', marker], [{ type: 'run_status', status: 'success' }], setup);
    const { body } = await call('POST', `/api/evals/${ev.id}/runs`);
    assert.equal((await waitForVerdict(ev.id, body.result.id)).passed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('running an eval checks its id', async () => {
  assert.equal((await call('POST', '/api/evals/nope/runs')).status, 400);
  assert.equal((await call('POST', '/api/evals/00000000-0000-0000-0000-000000000000/runs')).status, 404);
});

// Runs `rewind <args>` against the test server.
function rewind(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, REWIND_SERVER_URL: baseUrl } });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('rewind eval exits 0 when every eval passes', async () => {
  const a = await newEval(['calls', 'hello'], passing);
  const b = await newEval(['calls', 'hello'], [{ type: 'must_not_call_tool', tool: 'delete_file' }]);
  const { code, stderr } = await rewind(['eval', a.id, b.id]);
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`PASS  ${a.id.slice(0, 8)}`));
  assert.match(stderr, /2 of 2 evals passed/);
});

test('rewind eval exits 1 and prints why an eval failed', async () => {
  const ok = await newEval(['calls', 'hello'], passing);
  const bad = await newEval(['calls', 'hello'], [{ type: 'max_steps', max: 1 }, { type: 'must_call_tool', tool: 'move_file' }]);
  const { code, stderr } = await rewind(['eval', ok.id, bad.id]);
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`FAIL  ${bad.id.slice(0, 8)}`));
  assert.match(stderr, /- never called move_file/);
  assert.match(stderr, /1 of 2 evals passed/);
});

test('rewind eval reports an unknown eval and exits 1', async () => {
  const { code, stderr } = await rewind(['eval', '00000000-0000-0000-0000-000000000000']);
  assert.equal(code, 1);
  assert.match(stderr, /ERROR 00000000: could not start: .*404/);
});

test('rewind eval rejects bad arguments', async () => {
  for (const args of [['eval'], ['eval', 'nope'], ['eval', '--all', evalIds[0] ?? 'x']]) {
    const { code, stderr } = await rewind(args);
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, /usage: rewind eval/);
  }
  assert.equal((await rewind(['toString'])).code, 1);
});

// --all is only checked here: running it would launch every saved eval,
// real agents included.
test('parseEvalArgs', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  assert.deepEqual(parseEvalArgs(['--all']), { all: true, ids: [] });
  assert.deepEqual(parseEvalArgs([id]), { all: false, ids: [id] });
  assert.throws(() => parseEvalArgs([]), /missing eval id/);
  assert.throws(() => parseEvalArgs(['--all', id]), /--all takes no eval ids/);
  assert.throws(() => parseEvalArgs(['abc']), /not an eval id/);
});
