// Assertion checker tests: pure functions over fake runs and steps, no Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertionsError, checkAssertions, finalOutput } from '../src/assertions.js';

// Steps shaped like the ones getRun returns, with idx in order.
function llm(content, { toolCall = false } = {}) {
  const message = { role: 'assistant', content };
  if (toolCall) message.tool_calls = [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }];
  return { type: 'llm', request: {}, response: { choices: [{ message }] }, error: null };
}
function tool(name, error = null) {
  return { type: 'tool', request: { name, arguments: {} }, response: { content: [] }, error };
}
const numbered = (steps) => steps.map((s, idx) => ({ ...s, idx }));

const run = { status: 'success' };
// 0 llm, 1 list_files, 2 llm, 3 move_file (error), 4 llm, 5 move_file, 6 llm answer
const steps = numbered([
  llm('', { toolCall: true }),
  tool('list_files'),
  llm('', { toolCall: true }),
  tool('move_file', '{"error":"Already exists"}'),
  llm('', { toolCall: true }),
  tool('move_file'),
  llm('All files are Sorted into folders.'),
]);

const check = (assertion, r = run, s = steps) => checkAssertions(r, s, [assertion]);
const message = (assertion, r, s) => check(assertion, r, s).failures[0]?.message ?? null;

test('run_status', () => {
  assert.equal(message({ type: 'run_status', status: 'success' }), null);
  assert.equal(
    message({ type: 'run_status', status: 'success' }, { status: 'failed' }),
    'run status was failed, expected success',
  );
});

test('max_steps counts LLM and tool steps', () => {
  assert.equal(message({ type: 'max_steps', max: 7 }), null);
  assert.equal(message({ type: 'max_steps', max: 6 }), 'took 7 steps, max 6');
});

test('must_call_tool', () => {
  assert.equal(message({ type: 'must_call_tool', tool: 'move_file' }), null);
  assert.equal(message({ type: 'must_call_tool', tool: 'create_folder' }), 'never called create_folder');
});

test('must_not_call_tool lists the steps that called it', () => {
  assert.equal(message({ type: 'must_not_call_tool', tool: 'read_file' }), null);
  assert.equal(message({ type: 'must_not_call_tool', tool: 'move_file' }), 'called move_file at steps 3, 5');
});

test('max_tool_errors counts tool steps with an error', () => {
  assert.equal(message({ type: 'max_tool_errors', max: 1 }), null);
  assert.equal(message({ type: 'max_tool_errors', max: 0 }), '1 tool errors (steps 3), max 0');
});

test('LLM errors do not count as tool errors', () => {
  const s = numbered([{ ...llm(''), response: null, error: 'upstream timeout' }, llm('done')]);
  assert.equal(message({ type: 'max_tool_errors', max: 0 }, run, s), null);
});

test('final_output_contains ignores case', () => {
  assert.equal(message({ type: 'final_output_contains', text: 'sorted' }), null);
  assert.equal(message({ type: 'final_output_contains', text: 'ALL FILES' }), null);
  assert.equal(
    message({ type: 'final_output_contains', text: 'deleted' }),
    'final output doesn\'t contain "deleted"',
  );
});

test('finalOutput skips an LLM step that died mid-call', () => {
  const s = numbered([llm('first answer'), tool('list_files'), { ...llm(''), response: null }]);
  assert.equal(finalOutput(s), 'first answer');
});

test('finalOutput is empty when the run ended on a tool call or has no LLM step', () => {
  assert.equal(finalOutput(numbered([llm(null, { toolCall: true }), tool('list_files')])), '');
  assert.equal(finalOutput([]), '');
  assert.equal(message({ type: 'final_output_contains', text: 'x' }, run, []), 'final output doesn\'t contain "x"');
});

test('finalOutput reads the text blocks of an Anthropic reply', () => {
  const anthropic = (content) => ({ type: 'llm', format: 'anthropic', request: {}, response: { content }, error: null });
  const s = numbered([
    anthropic([{ type: 'tool_use', id: 't', name: 'list_files', input: {} }]),
    tool('list_files'),
    anthropic([
      { type: 'thinking', thinking: 'All moved.', signature: 's' },
      { type: 'text', text: 'All files are' },
      { type: 'text', text: 'sorted.' },
    ]),
  ]);
  assert.equal(finalOutput(s), 'All files are\nsorted.');
  assert.equal(message({ type: 'final_output_contains', text: 'SORTED' }, run, s), null);
  // An Anthropic error body has no content: no output, not a crash.
  assert.equal(finalOutput([{ ...anthropic(undefined), response: { type: 'error' }, idx: 0 }]), '');
});

test('several failures are all reported, with their index', () => {
  const assertions = [
    { type: 'run_status', status: 'success' },
    { type: 'max_steps', max: 3 },
    { type: 'must_call_tool', tool: 'move_file' },
    { type: 'must_not_call_tool', tool: 'move_file' },
  ];
  const result = checkAssertions(run, steps, assertions);
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures.map((f) => f.index), [1, 3]);
  assert.deepEqual(result.failures[1].assertion, assertions[3]);
});

test('all passing gives passed true and no failures', () => {
  const result = checkAssertions(run, steps, [
    { type: 'run_status', status: 'success' },
    { type: 'must_call_tool', tool: 'list_files' },
  ]);
  assert.deepEqual(result, { passed: true, failures: [] });
});

test('assertionsError accepts every valid type', () => {
  assert.equal(
    assertionsError([
      { type: 'run_status', status: 'failed' },
      { type: 'max_steps', max: 1 },
      { type: 'must_call_tool', tool: 'a' },
      { type: 'must_not_call_tool', tool: 'b' },
      { type: 'max_tool_errors', max: 0 },
      { type: 'final_output_contains', text: 'done' },
    ]),
    null,
  );
});

test('assertionsError rejects bad assertions', () => {
  for (const bad of [
    undefined,
    {},
    [],
    ['max_steps'],
    [{ max: 3 }],
    [{ type: 'must_not_loop' }],
    [{ type: 'toString' }],
    [{ type: 'run_status', status: 'running' }],
    [{ type: 'max_steps' }],
    [{ type: 'max_steps', max: 0 }],
    [{ type: 'max_steps', max: 2.5 }],
    [{ type: 'max_steps', max: '20' }],
    [{ type: 'max_tool_errors', max: -1 }],
    [{ type: 'must_call_tool', tool: '' }],
    [{ type: 'must_call_tool', tool: 'x', args: {} }],
    [{ type: 'final_output_contains', text: 3 }],
    [{ type: 'run_status', status: 'success' }, { type: 'max_steps', maximum: 20 }],
  ]) {
    assert.equal(typeof assertionsError(bad), 'string', JSON.stringify(bad));
  }
});

test('assertionsError names the assertion and field', () => {
  assert.equal(
    assertionsError([{ type: 'run_status', status: 'success' }, { type: 'max_steps', max: 0 }]),
    'assertions[1].max must be a positive integer',
  );
  assert.equal(
    assertionsError([{ type: 'must_call_tool', tool: 'x', args: {} }]),
    'assertions[0] has an unknown field "args" for must_call_tool',
  );
});
