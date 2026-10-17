// Eval API tests against the real Postgres from docker-compose.yml.
// Every run they create is named 'evals-test'; their evals and the runs are
// deleted afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';

const TEST_NAME = 'evals-test';
const COMMAND = ['node', 'examples/agent/index.js', 'sort the files'];
const ASSERTIONS = [{ type: 'run_status', status: 'success' }, { type: 'max_steps', max: 20 }];
const evalIds = [];
let server;
let baseUrl;

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  // Evals outlive their source run (SET NULL), so delete them by id.
  await pool.query('DELETE FROM evals WHERE id = ANY($1::uuid[])', [evalIds]); // results cascade
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
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

async function newRun(status = 'success') {
  const { body: run } = await call('POST', '/api/runs', { name: TEST_NAME, command: COMMAND, cwd: 'C:/Projects/Rewind' });
  if (status !== 'running') await call('PATCH', `/api/runs/${run.id}`, { status });
  return run;
}

async function newEval(run, extra = {}) {
  const res = await call('POST', '/api/evals', {
    source_run_id: run.id,
    input_task: 'sort the files',
    assertions: ASSERTIONS,
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  evalIds.push(res.body.id);
  return res.body;
}

// Results are only written by the server when an eval run exits (step 4),
// so the tests insert them directly.
async function addResult(evalId, passed, failures = null) {
  const run = await newRun(passed === null ? 'running' : passed ? 'success' : 'failed');
  await pool.query(
    'INSERT INTO eval_results (eval_id, run_id, passed, failures) VALUES ($1, $2, $3, $4)',
    [evalId, run.id, passed, failures == null ? null : JSON.stringify(failures)],
  );
  return run;
}

test('POST /api/evals copies command and cwd from the source run', async () => {
  const run = await newRun();
  const setup = ['node', 'examples/agent/seed.js'];
  const ev = await newEval(run, { setup });
  assert.match(ev.id, /^[0-9a-f-]{36}$/);
  assert.equal(ev.source_run_id, run.id);
  assert.equal(ev.input_task, 'sort the files');
  assert.deepEqual(ev.command, COMMAND);
  assert.equal(ev.cwd, 'C:/Projects/Rewind');
  assert.deepEqual(ev.setup, setup);
  assert.deepEqual(ev.assertions, ASSERTIONS);
});

test('setup is optional', async () => {
  const ev = await newEval(await newRun('failed'));
  assert.equal(ev.setup, null);
});

test('POST /api/evals needs a finished run that exists', async () => {
  const running = await newRun('running');
  const body = { input_task: 't', assertions: ASSERTIONS };
  assert.equal((await call('POST', '/api/evals', { ...body, source_run_id: running.id })).status, 409);
  const missing = '00000000-0000-0000-0000-000000000000';
  assert.equal((await call('POST', '/api/evals', { ...body, source_run_id: missing })).status, 404);
});

test('POST /api/evals validates its body', async () => {
  const run = await newRun();
  const good = { source_run_id: run.id, input_task: 'sort the files', assertions: ASSERTIONS };
  for (const bad of [
    { source_run_id: 'nope' },
    { input_task: '' },
    { input_task: 3 },
    { assertions: undefined },
    { assertions: [] },
    { assertions: {} },
    { assertions: ['max_steps'] },
    { assertions: [{ max: 3 }] },
    { setup: 'node seed.js' },
    { setup: [] },
  ]) {
    const res = await call('POST', '/api/evals', { ...good, ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(typeof res.body.error, 'string');
  }
});

test('GET /api/evals/:id returns its results newest first, with run status', async () => {
  const ev = await newEval(await newRun());
  const failures = [{ assertion: ASSERTIONS[1], message: 'took 25 steps, max 20' }];
  const failedRun = await addResult(ev.id, false, failures);
  const pendingRun = await addResult(ev.id, null);

  const res = await call('GET', `/api/evals/${ev.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, ev.id);
  assert.deepEqual(res.body.results.map((r) => r.run_id), [pendingRun.id, failedRun.id]);
  assert.deepEqual(res.body.results.map((r) => r.passed), [null, false]);
  assert.deepEqual(res.body.results.map((r) => r.run_status), ['running', 'failed']);
  assert.deepEqual(res.body.results[1].failures, failures);
});

test('GET /api/evals/:id rejects a bad or unknown id', async () => {
  assert.equal((await call('GET', '/api/evals/nope')).status, 400);
  assert.equal((await call('GET', '/api/evals/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('GET /api/evals lists evals with counts and the latest result', async () => {
  const empty = await newEval(await newRun());
  const ev = await newEval(await newRun());
  await addResult(ev.id, true);
  await addResult(ev.id, false, []);
  const latestRun = await addResult(ev.id, null);

  const res = await call('GET', '/api/evals');
  assert.equal(res.status, 200);
  const row = res.body.find((e) => e.id === ev.id);
  assert.equal(row.result_count, 3);
  assert.equal(row.checked_count, 2);
  assert.equal(row.passed_count, 1);
  assert.equal(row.latest_result.run_id, latestRun.id);
  assert.equal(row.latest_result.passed, null);

  const emptyRow = res.body.find((e) => e.id === empty.id);
  assert.equal(emptyRow.result_count, 0);
  assert.equal(emptyRow.latest_result, null);
  // Newest first: ev was created after empty.
  assert.ok(res.body.indexOf(row) < res.body.indexOf(emptyRow));
});

test('an eval survives deleting its source run', async () => {
  const run = await newRun();
  const ev = await newEval(run);
  await pool.query('DELETE FROM runs WHERE id = $1', [run.id]);
  const res = await call('GET', `/api/evals/${ev.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.source_run_id, null);
  assert.deepEqual(res.body.command, COMMAND);
});
