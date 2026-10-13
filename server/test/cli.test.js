// CLI tests: the real bin/rewind.js runs as a subprocess against a test
// server (with a fake upstream) and a fake agent. Postgres must be up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { parseRunArgs, recordRun } from '../src/cli.js';

const TEST_NAME = 'cli-test';
const BIN = fileURLToPath(new URL('../bin/rewind.js', import.meta.url));
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
let serverUrl;

const listen = async (srv) => {
  srv.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  return `http://localhost:${srv.address().port}`;
};

before(async () => {
  await migrate();
  const upstreamUrl = await listen(upstream);
  server = http.createServer(createApp({ upstreamUrl }));
  serverUrl = await listen(server);
});

after(async () => {
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
  server.close();
  upstream.close();
  await pool.end();
});

// Runs `rewind <args>` and collects its exit code and output.
function rewind(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, REWIND_SERVER_URL: serverUrl, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function getRun(id) {
  const { rows } = await pool.query('SELECT * FROM runs WHERE id = $1', [id]);
  return rows[0];
}

const runIdFrom = (stderr) => stderr.match(/run ([0-9a-f-]{36}) started/)[1];

test('parseRunArgs splits options from the command at --', () => {
  assert.deepEqual(parseRunArgs(['--name', 'demo', '--', 'node', 'a.js', 'sort the files']), {
    name: 'demo',
    command: ['node', 'a.js', 'sort the files'],
  });
  // A second -- belongs to the command.
  assert.deepEqual(parseRunArgs(['--', 'node', 'a.js', '--', 'x']), { name: null, command: ['node', 'a.js', '--', 'x'] });
  assert.throws(() => parseRunArgs(['node', 'a.js']), /missing "--"/);
  assert.throws(() => parseRunArgs(['--']), /missing command/);
  assert.throws(() => parseRunArgs(['--name', '--', 'node']), /incomplete option "--name"/);
  assert.throws(() => parseRunArgs(['--nmae', 'x', '--', 'node']), /unknown/);
});

test('records a successful run: env set, LLM call recorded, status success', async () => {
  // Quotes, & and spaces would break or inject through a shell; spawn passes them as-is.
  const text = 'say "hi" & echo pwned';
  const { code, stdout, stderr } = await rewind(['run', '--name', TEST_NAME, '--', process.execPath, FAKE_AGENT, 'call', text]);
  assert.equal(code, 0, stderr);

  const report = JSON.parse(stdout); // stdout is only the agent's output
  const runId = runIdFrom(stderr);
  assert.equal(report.runId, runId);
  assert.equal(report.baseUrl, `${serverUrl}/r/${runId}/v1`);
  assert.equal(report.arg, text);
  assert.equal(report.reply, `echo: ${text}`);

  const run = await getRun(runId);
  assert.equal(run.status, 'success');
  assert.equal(run.name, TEST_NAME);
  assert.deepEqual(run.command, [process.execPath, FAKE_AGENT, 'call', text]);
  assert.equal(run.cwd, process.cwd());

  const { rows: steps } = await pool.query('SELECT idx, type, response FROM steps WHERE run_id = $1', [runId]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'llm');
  assert.equal(steps[0].response.choices[0].message.content, `echo: ${text}`);
  assert.match(stderr, new RegExp(`run ${runId} success`));
});

test('a non-zero exit marks the run failed and is passed through', async () => {
  const { code, stderr } = await rewind(['run', '--name', TEST_NAME, '--', process.execPath, FAKE_AGENT, 'exit', '3']);
  assert.equal(code, 3);
  assert.equal((await getRun(runIdFrom(stderr))).status, 'failed');
});

test('a command that cannot start marks the run failed', async () => {
  const { code, stderr } = await rewind(['run', '--name', TEST_NAME, '--', 'no-such-command-xyz']);
  assert.equal(code, 1);
  assert.match(stderr, /could not start "no-such-command-xyz": ENOENT/);
  assert.equal((await getRun(runIdFrom(stderr))).status, 'failed');
});

test('an unreachable server fails fast without running the agent', async () => {
  const { code, stdout, stderr } = await rewind(
    ['run', '--', process.execPath, FAKE_AGENT, 'call', 'x'],
    { REWIND_SERVER_URL: 'http://127.0.0.1:1' },
  );
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /is the Rewind server running/);
});

test('bad arguments print usage and exit 1', async () => {
  const { code, stderr } = await rewind(['run', 'node', 'a.js']);
  assert.equal(code, 1);
  assert.match(stderr, /usage: rewind run/);
});

test('Ctrl+C stops the agent and marks the run failed', async () => {
  // In-process, because a real Ctrl+C can't be sent to a subprocess on
  // Windows. process.emit('SIGINT') calls the CLI's handler the same way.
  const done = recordRun({ name: TEST_NAME, command: [process.execPath, FAKE_AGENT, 'sleep'], serverUrl });

  // Wait until the run exists, then interrupt.
  let runId;
  for (let i = 0; i < 100 && !runId; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { rows } = await pool.query(
      `SELECT id FROM runs WHERE name = $1 AND status = 'running' AND command->>2 = 'sleep'`,
      [TEST_NAME],
    );
    runId = rows[0]?.id;
  }
  assert.ok(runId, 'run was not created');
  process.emit('SIGINT');

  assert.equal(await done, 130);
  assert.equal((await getRun(runId)).status, 'failed');
});
