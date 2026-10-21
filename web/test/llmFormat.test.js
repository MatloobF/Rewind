import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyMessage, requestMessages } from '../src/llmFormat.js';
import { previousMessageCount, stepSummary } from '../src/steps.js';

const openaiStep = {
  idx: 0,
  type: 'llm',
  format: 'openai',
  request: { messages: [{ role: 'user', content: 'hi' }] },
  response: { choices: [{ message: { role: 'assistant', content: 'hello' } }] },
};

test('OpenAI steps are read as they are', () => {
  assert.deepEqual(requestMessages(openaiStep), openaiStep.request.messages);
  assert.deepEqual(replyMessage(openaiStep), { role: 'assistant', content: 'hello' });
});

// An Anthropic conversation: a tool call, then its result sent back.
const anthropicStep = {
  idx: 2,
  type: 'llm',
  format: 'anthropic',
  request: {
    system: [{ type: 'text', text: 'You organize files.' }],
    messages: [
      { role: 'user', content: 'sort the files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.png' }] },
          { type: 'text', text: 'Keep going.' },
        ],
      },
    ],
  },
  response: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'One image.', signature: 's' },
      { type: 'text', text: 'Moving it.' },
      { type: 'tool_use', id: 'toolu_2', name: 'move_file', input: { from: 'a.png', to: 'images/a.png' } },
    ],
    stop_reason: 'tool_use',
  },
};

test('Anthropic request messages are shown as chat messages', () => {
  assert.deepEqual(requestMessages(anthropicStep), [
    { role: 'system', content: 'You organize files.' },
    { role: 'user', content: 'sort the files' },
    {
      role: 'assistant',
      content: 'Looking.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }],
    },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'a.png' },
    { role: 'user', content: 'Keep going.' },
  ]);
});

test('an Anthropic reply becomes one assistant message with thinking and tool calls', () => {
  assert.deepEqual(replyMessage(anthropicStep), {
    role: 'assistant',
    content: 'Moving it.',
    thinking: 'One image.',
    tool_calls: [{
      id: 'toolu_2',
      type: 'function',
      function: { name: 'move_file', arguments: '{"from":"a.png","to":"images/a.png"}' },
    }],
  });
  assert.equal(stepSummary(anthropicStep), 'move_file');
});

test('a user message of only tool results gives only tool messages; errors are marked', () => {
  const step = {
    format: 'anthropic',
    request: {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'no such file', is_error: true }],
      }],
    },
  };
  assert.deepEqual(requestMessages(step), [{ role: 'tool', tool_call_id: 't', content: '(error) no such file' }]);
});

test('images are a placeholder, not their data', () => {
  const step = {
    format: 'anthropic',
    request: {
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo...' } },
          { type: 'text', text: 'What is this?' },
        ],
      }],
    },
  };
  assert.deepEqual(requestMessages(step), [{ role: 'user', content: '[image]\n\nWhat is this?' }]);
});

test('an Anthropic step with no reply yet, or an error body, has no reply message', () => {
  assert.equal(replyMessage({ format: 'anthropic', response: null }), null);
  assert.equal(replyMessage({ format: 'anthropic', response: { type: 'error', error: {} } }), null);
  assert.equal(stepSummary({ type: 'llm', format: 'anthropic', response: null, error: null }), 'waiting for response');
});

test('new messages are counted in the mapped messages', () => {
  // The step before sent the system prompt and the task: 2 mapped messages.
  const previous = { ...anthropicStep, idx: 0, request: { ...anthropicStep.request, messages: anthropicStep.request.messages.slice(0, 1) } };
  assert.equal(previousMessageCount([previous, anthropicStep], anthropicStep), 2);
});

// OpenAI-format LLM step with the given idx and message texts (alternating user/assistant).
const chatStep = (idx, ...texts) => ({
  idx,
  type: 'llm',
  format: 'openai',
  request: { messages: texts.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })) },
});

test('a step in an unrelated conversation has only new messages', () => {
  // The Phase 10 streaming check: two one-message calls that share nothing.
  const steps = [chatStep(0, 'Say hello'), chatStep(1, 'Say goodbye')];
  assert.equal(previousMessageCount(steps, steps[1]), 0);
});

test('a side call in between does not hide the main conversation', () => {
  // Main call, a small side call (e.g. a title), then the main conversation goes on.
  const steps = [chatStep(0, 'task'), chatStep(1, 'title this'), chatStep(2, 'task', 'reply', 'more')];
  assert.equal(previousMessageCount(steps, steps[2]), 1);
});

test('only identical messages count as already sent', () => {
  const steps = [chatStep(0, 'task', 'reply'), chatStep(1, 'task', 'edited reply', 'more')];
  assert.equal(previousMessageCount(steps, steps[1]), 1);
});
