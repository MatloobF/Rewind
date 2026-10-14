import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mcpTools, connectMcpTools } from '../toolClient.js';
import { createServer } from '../mcp-server.js';
import { toolDefinitions } from '../tools.js';

async function connected() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-client-'));
  const server = createServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { server, tools: await mcpTools(client) };
}

test('definitions round-trip through MCP unchanged', async () => {
  const { tools } = await connected();
  assert.equal(JSON.stringify(tools.definitions), JSON.stringify(toolDefinitions));
  await tools.close();
});

test('call returns the tool result text, including tool errors', async () => {
  const { tools } = await connected();
  assert.deepEqual(JSON.parse(await tools.call('create_folder', { path: 'x' })), { path: 'x', created: true });
  assert.deepEqual(JSON.parse(await tools.call('nope', {})), { error: 'Unknown tool: nope' });
  await tools.close();
});

test('a protocol error (server gone) becomes an { error } result, not a throw', async () => {
  const { server, tools } = await connected();
  await server.close();
  const { error } = JSON.parse(await tools.call('list_files', { path: '.' }));
  assert.match(error, /^Tool call failed: /);
});

// Launches the real proxy and server processes. Only lists tools, so the real sandbox
// is never touched.
test('connectMcpTools launches the server behind the MCP proxy', async () => {
  const tools = await connectMcpTools();
  try {
    assert.equal(JSON.stringify(tools.definitions), JSON.stringify(toolDefinitions));
  } finally {
    await tools.close();
  }
});
