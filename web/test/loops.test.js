import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLoop } from '../src/loops.js';

test('one tool call repeated', () => {
  const loop = { kind: 'tool_cycle', tools: ['list_files'], period: 1, repeats: 5, step_idxs: [1, 3, 5, 7, 9] };
  assert.equal(describeLoop(loop), 'list_files called 5 times in a row with the same arguments');
});

test('a cycle of two calls', () => {
  const loop = { kind: 'tool_cycle', tools: ['list_files', 'read_file'], period: 2, repeats: 3, step_idxs: [] };
  assert.equal(describeLoop(loop), 'list_files → read_file repeated 3 times in a row');
});

test('a repeated LLM request', () => {
  assert.equal(
    describeLoop({ kind: 'repeated_llm_request', repeats: 2, step_idxs: [0, 4] }),
    'the same LLM request was sent 2 times',
  );
});

test('an unknown kind still says something', () => {
  assert.equal(describeLoop({ kind: 'new_kind', repeats: 4 }), 'new_kind (4 times)');
});
