// API tests against the real Postgres from docker-compose.yml.
// Every run they create is named 'api-test' and deleted afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { hashRequest } from '../src/hash.js';

const TEST_NAME = 'api-test';
let server;
let baseUrl;

before(async () => {
  await migrate();
  server = createApp().listen(0); // 0 = any free port
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]); // steps cascade
  server.close();
  await pool.end();
});

async function call(method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function newRun() {
  const { status, body } = await call('POST', '/api/runs', {
    name: TEST_NAME,
    command: ['node', 'examples/agent/index.js', 'sort the files'],
    cwd: 'C:/Projects/Rewind',
  });
  assert.equal(status, 201);
  return body;
}

const llmRequest = { model: 'rewind-qwen', messages: [{ role: 'user', content: 'hi' }] };

test('POST /api/runs creates a running run with an argv command', async () => {
  const run = await newRun();
  assert.match(run.id, /^[0-9a-f-]{36}$/);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.command, ['node', 'examples/agent/index.js', 'sort the files']);
  assert.equal(run.parent_run_id, null);
});

test('POST /api/runs rejects a bad command or cwd', async () => {
  for (const body of [
    { cwd: '.' },
    { command: 'node index.js', cwd: '.' },
    { command: [], cwd: '.' },
    { command: ['node', 1], cwd: '.' },
    { command: ['node'] },
  ]) {
    const res = await call('POST', '/api/runs', { name: TEST_NAME, ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof res.body.error, 'string');
  }
});

test('steps get idx 0, 1, 2 in order, start live with response NULL', async () => {
  const run = await newRun();
  for (const [i, type] of ['llm', 'tool', 'llm'].entries()) {
    const res = await call('POST', `/api/runs/${run.id}/steps`, { type, request: llmRequest });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { idx: i, mode: 'live' });
  }
  const { rows } = await pool.query(
    'SELECT idx, type, response, request_hash, replayed FROM steps WHERE run_id = $1 ORDER BY idx',
    [run.id],
  );
  assert.deepEqual(rows.map((r) => r.type), ['llm', 'tool', 'llm']);
  for (const row of rows) {
    assert.equal(row.response, null);
    assert.equal(row.replayed, false);
    assert.equal(row.request_hash, hashRequest(llmRequest));
  }
});

test('20 steps started at once get idx 0..19 with no duplicates', async () => {
  const run = await newRun();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => call('POST', `/api/runs/${run.id}/steps`, { type: 'tool', request: { n: 1 } })),
  );
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.body)));
  const idxs = results.map((r) => r.body.idx).sort((a, b) => a - b);
  assert.deepEqual(idxs, Array.from({ length: 20 }, (_, i) => i));
});

test('starting a step validates input and the run', async () => {
  const run = await newRun();
  assert.equal((await call('POST', `/api/runs/${run.id}/steps`, { type: 'other', request: {} })).status, 400);
  assert.equal((await call('POST', `/api/runs/${run.id}/steps`, { type: 'llm', request: [] })).status, 400);
  assert.equal((await call('POST', `/api/runs/${run.id}/steps`, { type: 'llm' })).status, 400);
  assert.equal((await call('POST', '/api/runs/not-a-uuid/steps', { type: 'llm', request: {} })).status, 400);
  const missing = '00000000-0000-0000-0000-000000000000';
  assert.equal((await call('POST', `/api/runs/${missing}/steps`, { type: 'llm', request: {} })).status, 404);
});

test('finishing a step saves the result once', async () => {
  const run = await newRun();
  await call('POST', `/api/runs/${run.id}/steps`, { type: 'llm', request: llmRequest });
  const result = {
    response: { choices: [{ message: { role: 'assistant', content: 'hello' } }] },
    latency_ms: 1234,
    tokens_in: 10,
    tokens_out: 2,
  };
  const res = await call('PATCH', `/api/runs/${run.id}/steps/0`, result);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.response, result.response);
  assert.equal(res.body.latency_ms, 1234);
  assert.equal(res.body.error, null);

  assert.equal((await call('PATCH', `/api/runs/${run.id}/steps/0`, result)).status, 409);
  assert.equal((await call('PATCH', `/api/runs/${run.id}/steps/5`, result)).status, 404);
  assert.equal((await call('PATCH', `/api/runs/${run.id}/steps/-1`, result)).status, 400);
});

test('a step can finish with only an error', async () => {
  const run = await newRun();
  await call('POST', `/api/runs/${run.id}/steps`, { type: 'tool', request: { name: 'read_file' } });
  const res = await call('PATCH', `/api/runs/${run.id}/steps/0`, { error: 'ENOENT', latency_ms: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.error, 'ENOENT');
  assert.equal(res.body.response, null);
  // A second finish is still refused, even though response is NULL.
  assert.equal((await call('PATCH', `/api/runs/${run.id}/steps/0`, { error: 'again' })).status, 409);
});

test('finishing a step validates the body', async () => {
  const run = await newRun();
  await call('POST', `/api/runs/${run.id}/steps`, { type: 'llm', request: llmRequest });
  const path = `/api/runs/${run.id}/steps/0`;
  assert.equal((await call('PATCH', path, {})).status, 400);
  assert.equal((await call('PATCH', path, { response: {}, tokens_in: -1 })).status, 400);
  assert.equal((await call('PATCH', path, { response: {}, latency_ms: 1.5 })).status, 400);
  assert.equal((await call('PATCH', path, { error: 42 })).status, 400);
});

test('PATCH /api/runs/:id sets the final status, then new steps are refused', async () => {
  const run = await newRun();
  assert.equal((await call('PATCH', `/api/runs/${run.id}`, { status: 'running' })).status, 400);
  const res = await call('PATCH', `/api/runs/${run.id}`, { status: 'success' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal((await call('POST', `/api/runs/${run.id}/steps`, { type: 'llm', request: {} })).status, 409);
  const missing = '00000000-0000-0000-0000-000000000000';
  assert.equal((await call('PATCH', `/api/runs/${missing}`, { status: 'failed' })).status, 404);
});

test('bad JSON gives 400 and unknown routes give 404', async () => {
  const res = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await call('GET', '/nope')).status, 404);
});
