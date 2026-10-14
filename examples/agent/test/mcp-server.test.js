import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../mcp-server.js';
import { toolDefinitions } from '../tools.js';

let root; // a fresh fake sandbox for every test
let client;

// Connects an MCP client to the server in-process, with a temporary sandbox.
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-mcp-'));
  await fs.writeFile(path.join(root, 'a.txt'), 'ay');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(root).connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});

// Tool results are JSON in a single text block.
const parse = (result) => JSON.parse(result.content[0].text);

test('lists the same tools as tools.js, in the same order', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    toolDefinitions.map(({ function: fn }) => ({
      name: fn.name,
      description: fn.description,
      inputSchema: fn.parameters,
    })),
  );
});

test('a successful call returns the tool result as JSON text', async () => {
  const result = await client.callTool({ name: 'list_files', arguments: { path: '.' } });
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(parse(result), { path: '.', entries: [{ name: 'a.txt', type: 'file' }] });
});

test('a sandbox escape comes back as isError, not a protocol error', async () => {
  const result = await client.callTool({ name: 'read_file', arguments: { path: '../secret.txt' } });
  assert.equal(result.isError, true);
  assert.match(parse(result).error, /sandbox/i);
});

test('an unknown tool comes back as isError', async () => {
  const result = await client.callTool({ name: 'delete_everything', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(parse(result), { error: 'Unknown tool: delete_everything' });
});

test('missing arguments come back as isError', async () => {
  const result = await client.callTool({ name: 'create_folder' });
  assert.equal(result.isError, true);
  assert.deepEqual(parse(result), { error: 'Missing or invalid argument: path' });
});

// The real entry point over stdio. It only lists tools, so the real sandbox
// is never touched.
test('runs as a stdio MCP server', async () => {
  const serverPath = fileURLToPath(new URL('../mcp-server.js', import.meta.url));
  const stdioClient = new Client({ name: 'test', version: '0.0.0' });
  await stdioClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: 'ignore',
  }));
  try {
    const { tools } = await stdioClient.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['list_files', 'read_file', 'create_folder', 'move_file']);
  } finally {
    await stdioClient.close();
  }
});
