import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignSteps, diffSummary } from '../src/diff.js';

// A step with just the fields the diff reads.
const step = (idx, hash, extra = {}) => ({ idx, type: 'llm', request_hash: hash, replayed: false, ...extra });

const run = (steps, extra = {}) => ({ steps, fork_step: null, diverged_at_step: null, fork_override: null, ...extra });

const kinds = (rows) => rows.map((r) => r.kind);

test('replay before the fork step, override at it, live after', () => {
  const parent = run([step(0, 'a'), step(1, 'b'), step(2, 'c'), step(3, 'd')]);
  const fork = run(
    [step(0, 'a', { replayed: true }), step(1, 'b'), step(2, 'c'), step(3, 'x')],
    { fork_step: 1, fork_override: { kind: 'response', response: {} } },
  );
  const rows = alignSteps(parent, fork);
  assert.deepEqual(kinds(rows), ['replayed', 'override', 'same-request', 'different-request']);
  assert.equal(rows[0].parent, parent.steps[0]);
  assert.equal(rows[0].fork, fork.steps[0]);
  assert.deepEqual(diffSummary(rows, fork), { replayed: 1, forkStep: 1, edit: 'response', divergedAt: null });
});

test('a fork that diverged before its fork step is live from there, not replayed', () => {
  const parent = run([step(0, 'a'), step(1, 'b'), step(2, 'c'), step(3, 'd')]);
  const fork = run(
    [step(0, 'a', { replayed: true }), step(1, 'z'), step(2, 'c'), step(3, 'd')],
    { fork_step: 3, diverged_at_step: 1, fork_override: { kind: 'request', request: {} } },
  );
  assert.deepEqual(kinds(alignSteps(parent, fork)), ['replayed', 'diverged', 'same-request', 'override']);
});

test('a fork with no edit that matches its parent', () => {
  const parent = run([step(0, 'a'), step(1, 'b'), step(2, 'c')]);
  const fork = run([step(0, 'a', { replayed: true }), step(1, 'b'), step(2, 'c')], { fork_step: 1 });
  const rows = alignSteps(parent, fork);
  assert.deepEqual(kinds(rows), ['replayed', 'override', 'same-request']);
  assert.equal(diffSummary(rows, fork).edit, null);
});

test('fork at step 0 replays nothing', () => {
  const parent = run([step(0, 'a'), step(1, 'b')]);
  const fork = run([step(0, 'a'), step(1, 'b')], { fork_step: 0 });
  const rows = alignSteps(parent, fork);
  assert.deepEqual(kinds(rows), ['override', 'same-request']);
  assert.equal(diffSummary(rows, fork).replayed, 0);
});

test('the fork runs longer than its parent', () => {
  const parent = run([step(0, 'a'), step(1, 'b')]);
  const fork = run([step(0, 'a', { replayed: true }), step(1, 'b'), step(2, 'c')], { fork_step: 1 });
  const rows = alignSteps(parent, fork);
  assert.deepEqual(kinds(rows), ['replayed', 'override', 'fork-only']);
  assert.equal(rows[2].parent, null);
});

test('the fork stops before its parent', () => {
  const parent = run([step(0, 'a'), step(1, 'b'), step(2, 'c')]);
  const fork = run([step(0, 'a', { replayed: true }), step(1, 'b')], { fork_step: 1 });
  const rows = alignSteps(parent, fork);
  assert.deepEqual(kinds(rows), ['replayed', 'override', 'parent-only']);
  assert.equal(rows[2].fork, null);
});

test('a fork with no steps yet', () => {
  const parent = run([step(0, 'a')]);
  const fork = run([], { fork_step: 0 });
  assert.deepEqual(kinds(alignSteps(parent, fork)), ['parent-only']);
  assert.deepEqual(alignSteps(run([]), fork), []);
});
