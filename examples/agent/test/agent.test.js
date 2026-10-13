import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runAgent } from '../agent.js';

// A fake OpenAI client that returns canned messages in order and records
// every request it receives.
function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        create: async (req) => {
          // Copy messages: the agent keeps pushing to the same array.
          requests.push({ ...req, messages: [...req.messages] });
          const message = typeof replies === 'function' ? replies(requests.length) : replies[requests.length - 1];
          return { choices: [{ message }] };
        },
      },
    },
  };
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  return root;
}

const quiet = () => {};

test('stops when the model answers without tool calls', async () => {
  const client = fakeClient([{ role: 'assistant', content: 'All done.' }]);
  const result = await runAgent('sort', { client, root: await tempRoot(), log: quiet });
  assert.deepEqual(result, { ok: true, answer: 'All done.', steps: 1 });
});

test('runs tool calls and sends results back', async () => {
  const root = await tempRoot();
  const client = fakeClient([
    { role: 'assistant', content: null, tool_calls: [
      toolCall('c1', 'create_folder', { path: 'docs' }),
      toolCall('c2', 'move_file', { from: 'a.txt', to: 'docs' }),
    ] },
    { role: 'assistant', content: 'Moved a.txt.' },
  ]);
  const result = await runAgent('sort', { client, root, log: quiet });

  assert.equal(result.ok, true);
  await fs.access(path.join(root, 'docs', 'a.txt'));
  const toolMessages = client.requests[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.deepEqual(JSON.parse(toolMessages[1].content), { from: 'a.txt', to: 'docs/a.txt' });
});

test('invalid JSON arguments become an error result, not a crash', async () => {
  const client = fakeClient([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'list_files', '{"path": ')] },
    { role: 'assistant', content: 'ok' },
  ]);
  await runAgent('sort', { client, root: await tempRoot(), log: quiet });
  const toolMessage = client.requests[1].messages.at(-1);
  assert.match(JSON.parse(toolMessage.content).error, /not valid JSON/);
});

test('stops at the step limit with ok = false', async () => {
  const client = fakeClient(() => ({
    role: 'assistant', content: null, tool_calls: [toolCall('c', 'list_files', { path: '.' })],
  }));
  const result = await runAgent('sort', { client, root: await tempRoot(), maxSteps: 3, log: quiet });
  assert.deepEqual(result, { ok: false, answer: '', steps: 3 });
  assert.equal(client.requests.length, 3);
});

test('requests are deterministic: same task gives identical first request', async () => {
  const a = fakeClient([{ role: 'assistant', content: 'x' }]);
  const b = fakeClient([{ role: 'assistant', content: 'x' }]);
  await runAgent('sort the files', { client: a, root: await tempRoot(), log: quiet });
  await runAgent('sort the files', { client: b, root: await tempRoot(), log: quiet });
  assert.equal(JSON.stringify(a.requests[0]), JSON.stringify(b.requests[0]));
  assert.equal(a.requests[0].temperature, 0);
});
