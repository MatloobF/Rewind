// Replay engine tests (Rule 6) against the real Postgres from docker-compose.yml.
// They call startStep/finishStep directly. Every run they create is named
// 'replay-test' and deleted afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { createRun, setRunStatus } from '../src/runs.js';
import { startStep, finishStep } from '../src/steps.js';
import { hashRequest } from '../src/hash.js';

const TEST_NAME = 'replay-test';
const COMMAND = ['node', 'examples/agent/index.js', 'sort the files'];

before(async () => {
  await migrate();
});

after(async () => {
  // Forks first: their parent_run_id points at the parents.
  await pool.query('DELETE FROM runs WHERE name = $1 AND parent_run_id IS NOT NULL', [TEST_NAME]);
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
  await pool.end();
});

const llmReq = (n) => ({ model: 'rewind-qwen', temperature: 0, messages: [{ role: 'user', content: `turn ${n}` }] });
const toolReq = (n) => ({ name: 'list_files', arguments: { path: `dir${n}` } });

// The parent the forks replay: llm, tool, llm, tool.
const PARENT_STEPS = [
  { type: 'llm', request: llmReq(0), result: { response: { answer: 0 }, tokens_in: 10, tokens_out: 1, latency_ms: 500 } },
  { type: 'tool', request: toolReq(1), result: { response: { content: ['a.txt'] }, latency_ms: 5 } },
  { type: 'llm', request: llmReq(2), result: { response: { answer: 2 }, tokens_in: 20, tokens_out: 2, latency_ms: 600 } },
  { type: 'tool', request: toolReq(3), result: { response: { content: ['b.txt'] }, latency_ms: 6 } },
];

// Records a finished run with the given steps (as the proxies would).
async function recordParent(steps = PARENT_STEPS) {
  const run = await createRun({ name: TEST_NAME, command: COMMAND, cwd: '.' });
  for (const { type, request, result } of steps) {
    const { idx } = await startStep(run.id, { type, request });
    if (result) await finishStep(run.id, idx, result);
  }
  await setRunStatus(run.id, 'success');
  return run;
}

function fork(parent, forkStep, forkOverride = null) {
  return createRun({ name: TEST_NAME, command: COMMAND, cwd: '.', parentRunId: parent.id, forkStep, forkOverride });
}

// Starts the steps in order and returns the modes the server answered with.
async function startAll(run, steps) {
  const modes = [];
  for (const { type, request } of steps) {
    modes.push((await startStep(run.id, { type, request })).mode);
  }
  return modes;
}

async function divergedAt(run) {
  const { rows } = await pool.query('SELECT diverged_at_step FROM runs WHERE id = $1', [run.id]);
  return rows[0].diverged_at_step;
}

async function stepsOf(run) {
  const { rows } = await pool.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY idx', [run.id]);
  return rows;
}

test('a run without a parent is always live', async () => {
  const run = await createRun({ name: TEST_NAME, command: COMMAND, cwd: '.' });
  assert.deepEqual(await startAll(run, PARENT_STEPS), ['live', 'live', 'live', 'live']);
});

test('fork at step 2 without an override: steps 0-1 replay, 2 and 3 go live', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 2);

  const first = await startStep(run.id, PARENT_STEPS[0]);
  assert.deepEqual(first, { idx: 0, mode: 'replay', response: { answer: 0 }, error: null });
  assert.deepEqual(await startAll(run, PARENT_STEPS.slice(1)), ['replay', 'live', 'live']);
  assert.equal(await divergedAt(run), null);

  const steps = await stepsOf(run);
  assert.deepEqual(steps.map((s) => s.replayed), [true, true, false, false]);
  // Replayed rows copy the parent's result and tokens, but no latency (no call was made).
  assert.deepEqual(steps[0].response, { answer: 0 });
  assert.equal(steps[0].tokens_in, 10);
  assert.equal(steps[0].tokens_out, 1);
  assert.equal(steps[0].latency_ms, null);
  assert.deepEqual(steps[1].response, { content: ['a.txt'] });
  // Live rows wait for the proxy to finish them.
  assert.equal(steps[2].response, null);
  assert.equal(steps[3].response, null);
});

test('fork at step 0 replays nothing', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 0);
  assert.deepEqual(await startAll(run, PARENT_STEPS), ['live', 'live', 'live', 'live']);
  assert.equal(await divergedAt(run), null);
});

test('fork at the last step replays everything before it', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 3);
  assert.deepEqual(await startAll(run, PARENT_STEPS), ['replay', 'replay', 'replay', 'live']);
  assert.equal(await divergedAt(run), null);
});

test('a replayed step cannot be finished', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 2);
  await startStep(run.id, PARENT_STEPS[0]);
  await assert.rejects(finishStep(run.id, 0, { response: { other: true } }), { status: 409 });
});

test('a request that differs before the fork step diverges, and the rest stays live', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 3);
  const steps = [PARENT_STEPS[0], { type: 'tool', request: toolReq(99) }, PARENT_STEPS[2], PARENT_STEPS[3]];
  // Step 2 matches the parent again, but the run has left the parent's path.
  assert.deepEqual(await startAll(run, steps), ['replay', 'live', 'live', 'live']);
  assert.equal(await divergedAt(run), 1);
});

test('a request that differs at the fork step itself diverges there', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 2);
  const steps = [PARENT_STEPS[0], PARENT_STEPS[1], { type: 'llm', request: llmReq(99) }];
  assert.deepEqual(await startAll(run, steps), ['replay', 'replay', 'live']);
  assert.equal(await divergedAt(run), 2);
});

test('a request that differs after the fork step is not a divergence', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 1);
  const steps = [PARENT_STEPS[0], PARENT_STEPS[1], { type: 'llm', request: llmReq(99) }];
  assert.deepEqual(await startAll(run, steps), ['replay', 'live', 'live']);
  assert.equal(await divergedAt(run), null);
});

test('a different step type with the same request diverges', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 2);
  assert.deepEqual(await startAll(run, [{ type: 'tool', request: llmReq(0) }]), ['live']);
  assert.equal(await divergedAt(run), 0);
});

test('key order does not matter: a reordered request still replays', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 1);
  const { messages, temperature, model } = llmReq(0);
  const reordered = { messages, temperature, model };
  assert.deepEqual(await startAll(run, [{ type: 'llm', request: reordered }]), ['replay']);
});

test('a parent shorter than the fork step diverges where it ends', async () => {
  const parent = await recordParent(PARENT_STEPS.slice(0, 2));
  const run = await fork(parent, 3);
  assert.deepEqual(await startAll(run, PARENT_STEPS), ['replay', 'replay', 'live', 'live']);
  assert.equal(await divergedAt(run), 2);
});

test('an unfinished parent step is not replayed', async () => {
  // The parent's agent died during step 1: its response stayed NULL.
  const steps = [PARENT_STEPS[0], { type: 'tool', request: toolReq(1) }];
  const parent = await recordParent(steps);
  const run = await fork(parent, 2);
  assert.deepEqual(await startAll(run, steps), ['replay', 'live']);
  assert.equal(await divergedAt(run), 1);
});

test('a parent step that failed is replayed with its error', async () => {
  const failed = { type: 'llm', request: llmReq(0), result: { error: 'upstream request failed: ECONNREFUSED' } };
  const parent = await recordParent([failed, PARENT_STEPS[1]]);
  const run = await fork(parent, 1);

  const res = await startStep(run.id, failed);
  assert.deepEqual(res, { idx: 0, mode: 'replay', response: null, error: 'upstream request failed: ECONNREFUSED' });
  const [step] = await stepsOf(run);
  assert.equal(step.replayed, true);
  assert.equal(step.response, null);
  assert.equal(step.error, 'upstream request failed: ECONNREFUSED');
});

// --- Override at the fork step ---

test('a response override is served at the fork step, and later steps go live', async () => {
  const parent = await recordParent();
  const edited = { content: ['edited.txt'] };
  const run = await fork(parent, 1, { kind: 'response', response: edited });

  await startStep(run.id, PARENT_STEPS[0]);
  const atFork = await startStep(run.id, PARENT_STEPS[1]);
  assert.deepEqual(atFork, { idx: 1, mode: 'override', response: edited });
  assert.deepEqual(await startAll(run, PARENT_STEPS.slice(2)), ['live', 'live']);

  const steps = await stepsOf(run);
  // Finished already, with the agent's own request, and not marked replayed.
  assert.deepEqual(steps[1].request, toolReq(1));
  assert.deepEqual(steps[1].response, edited);
  assert.equal(steps[1].replayed, false);
  assert.equal(steps[1].latency_ms, null);
  await assert.rejects(finishStep(run.id, 1, { response: {} }), { status: 409 });
  assert.equal(await divergedAt(run), null);
});

test('a request override is returned to send live, and the row stores the edited request', async () => {
  const parent = await recordParent();
  const edited = { ...llmReq(2), model: 'other-model' };
  const run = await fork(parent, 2, { kind: 'request', request: edited });

  await startAll(run, PARENT_STEPS.slice(0, 2));
  const atFork = await startStep(run.id, PARENT_STEPS[2]);
  assert.deepEqual(atFork, { idx: 2, mode: 'override', request: edited });

  const [, , step] = await stepsOf(run);
  assert.deepEqual(step.request, edited);
  assert.equal(step.request_hash, hashRequest(edited));
  assert.equal(step.response, null);
  assert.equal(step.replayed, false);
  // The proxy finishes it after the live call, like any live step.
  await finishStep(run.id, 2, { response: { answer: 'from other-model' }, latency_ms: 700 });
});

test('a fork at step 0 applies the override to the first step', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 0, { kind: 'response', response: { answer: 'edited' } });
  const res = await startStep(run.id, PARENT_STEPS[0]);
  assert.deepEqual(res, { idx: 0, mode: 'override', response: { answer: 'edited' } });
});

test('the override is skipped when the run diverged before the fork step', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 2, { kind: 'response', response: { answer: 'edited' } });
  const steps = [PARENT_STEPS[0], { type: 'tool', request: toolReq(99) }, PARENT_STEPS[2]];
  assert.deepEqual(await startAll(run, steps), ['replay', 'live', 'live']);
  assert.equal(await divergedAt(run), 1);
});

test('the override is skipped when the request at the fork step differs from the parent', async () => {
  const parent = await recordParent();
  const run = await fork(parent, 2, { kind: 'request', request: llmReq(42) });
  const steps = [PARENT_STEPS[0], PARENT_STEPS[1], { type: 'llm', request: llmReq(99) }];
  assert.deepEqual(await startAll(run, steps), ['replay', 'replay', 'live']);
  assert.equal(await divergedAt(run), 2);
  const [, , step] = await stepsOf(run);
  assert.deepEqual(step.request, llmReq(99)); // the agent's request, not the override
});

test('createRun rejects bad fork fields', async () => {
  const parent = await recordParent();
  const base = { name: TEST_NAME, command: COMMAND, cwd: '.' };
  const bad = [
    { forkStep: 1 }, // no parent
    { forkOverride: { kind: 'response', response: {} } }, // no parent
    { parentRunId: parent.id }, // no fork step
    { parentRunId: parent.id, forkStep: -1 },
    { parentRunId: parent.id, forkStep: 1.5 },
    { parentRunId: parent.id, forkStep: 1, forkOverride: 'edited' },
    { parentRunId: parent.id, forkStep: 1, forkOverride: { kind: 'model', model: 'x' } },
    { parentRunId: parent.id, forkStep: 1, forkOverride: { kind: 'response' } },
    { parentRunId: parent.id, forkStep: 1, forkOverride: { kind: 'request', request: [] } },
    { parentRunId: parent.id, forkStep: 1, forkOverride: { kind: 'response', response: {}, request: {} } },
  ];
  for (const fields of bad) {
    await assert.rejects(createRun({ ...base, ...fields }), { status: 400 }, JSON.stringify(fields));
  }
});
