import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runAgent } from '../agent.js';
import { localTools, mcpTools } from '../toolClient.js';
import { createServer } from '../mcp-server.js';

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
  const result = await runAgent('sort', { client, tools: localTools(await tempRoot()), log: quiet });
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
  const result = await runAgent('sort', { client, tools: localTools(root), log: quiet });

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
  await runAgent('sort', { client, tools: localTools(await tempRoot()), log: quiet });
  const toolMessage = client.requests[1].messages.at(-1);
  assert.match(JSON.parse(toolMessage.content).error, /not valid JSON/);
});

test('stops at the step limit with ok = false', async () => {
  const client = fakeClient(() => ({
    role: 'assistant', content: null, tool_calls: [toolCall('c', 'list_files', { path: '.' })],
  }));
  const result = await runAgent('sort', { client, tools: localTools(await tempRoot()), maxSteps: 3, log: quiet });
  assert.deepEqual(result, { ok: false, answer: '', steps: 3 });
  assert.equal(client.requests.length, 3);
});

test('requests are deterministic: same task gives identical first request', async () => {
  const a = fakeClient([{ role: 'assistant', content: 'x' }]);
  const b = fakeClient([{ role: 'assistant', content: 'x' }]);
  await runAgent('sort the files', { client: a, tools: localTools(await tempRoot()), log: quiet });
  await runAgent('sort the files', { client: b, tools: localTools(await tempRoot()), log: quiet });
  assert.equal(JSON.stringify(a.requests[0]), JSON.stringify(b.requests[0]));
  assert.equal(a.requests[0].temperature, 0);
});

test('throws without a tools option', async () => {
  const client = fakeClient([{ role: 'assistant', content: 'x' }]);
  await assert.rejects(runAgent('sort', { client, log: quiet }), /tools option/);
});

// MCP tools connected in-process to the real server code, on a temp sandbox.
async function mcpToolsOn(root) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(root).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return mcpTools(client);
}

// Moving the tools to MCP must not change a single byte of what the model
// sees, or recorded runs from before MCP would no longer replay.
test('MCP tools give byte-for-byte the same LLM requests as in-process tools', async () => {
  const replies = [
    { role: 'assistant', content: null, tool_calls: [
      toolCall('c1', 'list_files', { path: '.' }),
      toolCall('c2', 'create_folder', { path: 'docs' }),
      toolCall('c3', 'move_file', { from: 'a.txt', to: 'docs' }),
      toolCall('c4', 'read_file', { path: '../escape.txt' }), // an error result
      toolCall('c5', 'no_such_tool', {}),
    ] },
    { role: 'assistant', content: 'done' },
  ];
  const local = fakeClient(replies);
  await runAgent('sort the files', { client: local, tools: localTools(await tempRoot()), log: quiet });

  const tools = await mcpToolsOn(await tempRoot());
  const mcp = fakeClient(replies);
  try {
    await runAgent('sort the files', { client: mcp, tools, log: quiet });
  } finally {
    await tools.close();
  }

  assert.equal(mcp.requests.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(JSON.stringify(mcp.requests[i]), JSON.stringify(local.requests[i]));
  }
});
