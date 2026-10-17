import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertionsFromRows, describeAssertion, newRow, rowsFromDraft, verdict } from '../src/evals.js';

const draft = {
  run_id: 'r',
  input_task: 'sort the files',
  suggestions: [
    { assertion: { type: 'run_status', status: 'success' }, reason: 'it succeeded' },
    { assertion: { type: 'max_steps', max: 27 }, reason: '18 steps' },
    { assertion: { type: 'must_call_tool', tool: 'move_file' }, reason: 'used it' },
    { assertion: { type: 'max_tool_errors', max: 0 }, reason: 'no errors' },
  ],
};

test('a draft round-trips through the form rows unchanged', () => {
  const rows = rowsFromDraft(draft);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.include && !r.added));
  assert.equal(rows[1].value, '27');
  assert.equal(rows[1].reason, '18 steps');
  assert.deepEqual(assertionsFromRows(rows), draft.suggestions.map((s) => s.assertion));
});

test('every row gets its own id', () => {
  const ids = [...rowsFromDraft(draft), ...rowsFromDraft(draft)].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('unticked rows are left out', () => {
  const rows = rowsFromDraft(draft).map((r, i) => ({ ...r, include: i !== 2 }));
  assert.deepEqual(assertionsFromRows(rows).map((a) => a.type), ['run_status', 'max_steps', 'max_tool_errors']);
});

test('number fields become integers; anything else is sent as typed', () => {
  const rows = [
    { ...newRow('max_steps'), value: ' 12 ' },
    { ...newRow('max_tool_errors'), value: '2.5' },
    { ...newRow('max_steps'), value: '' },
  ];
  assert.deepEqual(assertionsFromRows(rows), [
    { type: 'max_steps', max: 12 },
    { type: 'max_tool_errors', max: '2.5' },
    { type: 'max_steps', max: '' },
  ]);
});

test('added rows: run_status starts at success, others empty', () => {
  const status = newRow('run_status');
  assert.equal(status.value, 'success');
  assert.equal(status.added, true);
  const text = { ...newRow('final_output_contains'), value: 'sorted' };
  assert.equal(newRow('must_call_tool').value, '');
  assert.deepEqual(assertionsFromRows([status, text]), [
    { type: 'run_status', status: 'success' },
    { type: 'final_output_contains', text: 'sorted' },
  ]);
});

test('describeAssertion', () => {
  assert.equal(describeAssertion({ type: 'run_status', status: 'success' }), 'run status is success');
  assert.equal(describeAssertion({ type: 'max_steps', max: 27 }), 'at most 27 steps');
  assert.equal(describeAssertion({ type: 'must_call_tool', tool: 'move_file' }), 'calls move_file');
  assert.equal(describeAssertion({ type: 'must_not_call_tool', tool: 'delete_file' }), 'never calls delete_file');
  assert.equal(describeAssertion({ type: 'max_tool_errors', max: 0 }), 'no tool errors');
  assert.equal(describeAssertion({ type: 'max_tool_errors', max: 2 }), 'at most 2 tool errors');
  assert.equal(describeAssertion({ type: 'final_output_contains', text: 'sorted' }), 'final output contains "sorted"');
});

test('verdict', () => {
  assert.equal(verdict(null), 'never');
  assert.equal(verdict(undefined), 'never');
  assert.equal(verdict({ passed: null }), 'running');
  assert.equal(verdict({ passed: true }), 'pass');
  assert.equal(verdict({ passed: false }), 'fail');
});
