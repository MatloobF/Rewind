import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, summarizeRun, summarizeStep } from '../src/summary.js';

// Recorded steps shaped like the real ones: LLM steps hold OpenAI chat
// completion bodies, tool steps hold MCP tool calls.
function llmStep(idx, message, extra = {}) {
  return {
    idx, type: 'llm', format: 'openai', replayed: false, latency_ms: 1000, tokens_in: 500, tokens_out: 40, error: null,
    request: {
      model: 'rewind-qwen',
      messages: [
        { role: 'system', content: 'You organize files.' },
        { role: 'user', content: 'sort the files' },
      ],
      tools: [{ type: 'function', function: { name: 'move_file', parameters: {} } }],
    },
    response: { choices: [{ message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] },
    ...extra,
  };
}

function toolStep(idx, name, args, text, extra = {}) {
  return {
    idx, type: 'tool', replayed: false, latency_ms: 5, tokens_in: null, tokens_out: null, error: null,
    request: { name, arguments: args },
    response: { content: [{ type: 'text', text }] },
    ...extra,
  };
}

const moveCall = { id: 'c1', type: 'function', function: { name: 'move_file', arguments: '{"from":"a.png","to":"images/a.png"}' } };

test('clip leaves short text alone and marks how much it cut', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('abcdefghij', 10), 'abcdefghij');
  assert.equal(clip('abcdefghijkl', 10), 'abcdefghij… (+2 chars)');
  assert.equal(clip(null), null);
  assert.equal(clip({ a: 1 }), '{"a":1}');
});

test('an LLM step with a text reply shows the reply, not the conversation', () => {
  const summary = summarizeStep(llmStep(4, { content: 'All files are sorted.' }));
  assert.deepEqual(summary, {
    idx: 4, type: 'llm', replayed: false, latency_ms: 1000, error: null,
    format: 'openai', tokens_in: 500, tokens_out: 40, messages_sent: 2,
    reply: 'All files are sorted.', tool_calls: [], finish_reason: 'stop',
  });
});

test('an LLM step with tool calls shows each call name and arguments', () => {
  const summary = summarizeStep(llmStep(0, { content: null, tool_calls: [moveCall] }));
  assert.equal(summary.reply, null);
  assert.deepEqual(summary.tool_calls, [{ name: 'move_file', arguments: '{"from":"a.png","to":"images/a.png"}' }]);
  assert.equal(summary.finish_reason, 'tool_calls');
});

test('an Anthropic LLM step is summarized in the same fields', () => {
  const step = {
    idx: 0, type: 'llm', format: 'anthropic', replayed: false, latency_ms: 900, tokens_in: 3210, tokens_out: 25, error: null,
    request: { model: 'claude-test', system: 'You organize files.', messages: [{ role: 'user', content: 'sort the files' }] },
    response: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Look first.', signature: 's' },
        { type: 'text', text: 'Listing files.' },
        { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } },
      ],
      stop_reason: 'tool_use',
    },
  };
  const summary = summarizeStep(step);
  assert.equal(summary.format, 'anthropic');
  assert.equal(summary.messages_sent, 1);
  assert.equal(summary.reply, 'Listing files.');
  assert.deepEqual(summary.tool_calls, [{ name: 'list_files', arguments: '{"path":"."}' }]);
  assert.equal(summary.finish_reason, 'tool_use');

  // An Anthropic error body: no reply, no calls, no crash.
  const failed = summarizeStep({ ...step, response: { type: 'error', error: { message: 'x' } }, error: 'upstream HTTP 400: x' });
  assert.equal(failed.reply, null);
  assert.deepEqual(failed.tool_calls, []);
});

test('a tool step shows the tool, its arguments and its result text', () => {
  const summary = summarizeStep(toolStep(1, 'move_file', { from: 'a.png', to: 'images/a.png' }, '{"ok":true}'));
  assert.deepEqual(summary, {
    idx: 1, type: 'tool', replayed: false, latency_ms: 5, error: null,
    tool: 'move_file', arguments: '{"from":"a.png","to":"images/a.png"}',
    result: '{"ok":true}', is_error: false,
  });
});

test('a tool step that returned isError is marked as an error', () => {
  const step = toolStep(3, 'read_file', { path: 'x.txt' }, '{"error":"Not found: x.txt"}', {
    error: '{"error":"Not found: x.txt"}',
  });
  step.response.isError = true;
  const summary = summarizeStep(step);
  assert.equal(summary.is_error, true);
  assert.equal(summary.error, '{"error":"Not found: x.txt"}');
});

test('a step that never got a response is marked no_response', () => {
  const summary = summarizeStep(llmStep(2, { content: 'x' }, { response: null, tokens_in: null, tokens_out: null }));
  assert.equal(summary.state, 'no_response');
  assert.equal(summary.reply, null);
  // A failed call has no response either, but its error says what happened.
  const failed = summarizeStep(llmStep(2, { content: 'x' }, { response: null, error: 'upstream HTTP 500' }));
  assert.equal('state' in failed, false);
  assert.equal(failed.error, 'upstream HTTP 500');
});

test('a replayed step keeps replayed: true', () => {
  const summary = summarizeStep(toolStep(1, 'list_files', {}, '[]', { replayed: true }));
  assert.equal(summary.replayed, true);
});

test('long replies, arguments and results are clipped', () => {
  const long = 'x'.repeat(250);
  const reply = summarizeStep(llmStep(0, { content: long })).reply;
  assert.equal(reply, `${'x'.repeat(200)}… (+50 chars)`);
  const tool = summarizeStep(toolStep(1, 'write_file', { path: 'a.txt', content: long }, long));
  assert.match(tool.arguments, /… \(\+\d+ chars\)$/);
  assert.equal(tool.result, `${'x'.repeat(200)}… (+50 chars)`);
});

test('summarizeRun adds totals and the task, and leaves out cwd', () => {
  const run = {
    id: 'r1', name: 'test', status: 'success', command: ['node', 'agent.js'], cwd: 'C:/x',
    created_at: '2026-10-18T00:00:00.000Z', parent_run_id: 'p1', fork_step: 1, diverged_at_step: null,
    fork_override: { kind: 'response', response: { content: [{ type: 'text', text: 'y'.repeat(300) }] } },
    steps: [
      llmStep(0, { content: null, tool_calls: [moveCall] }),
      toolStep(1, 'move_file', {}, '{"ok":true}'),
      llmStep(2, { content: 'Done.' }),
    ],
  };
  const { run: summary, task, steps } = summarizeRun(run);
  assert.equal(task, 'sort the files');
  assert.equal(steps.length, 3);
  assert.equal(summary.step_count, 3);
  assert.equal(summary.tokens_in, 1000);
  assert.equal(summary.tokens_out, 80);
  assert.equal(summary.latency_ms, 2005);
  assert.equal('cwd' in summary, false);
  assert.match(summary.fork_override, /^\{"kind":"response".*… \(\+\d+ chars\)$/);
});

test('summarizeRun handles a run with no steps', () => {
  const { run, task, steps } = summarizeRun({ id: 'r1', status: 'failed', fork_override: null, steps: [] });
  assert.deepEqual(steps, []);
  assert.equal(task, null);
  assert.equal(run.step_count, 0);
  assert.equal(run.tokens_in, 0);
  assert.equal(run.fork_override, null);
});
