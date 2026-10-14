import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseProxyArgs, createProxy } from '../src/proxy.js';
import { createUpstream, TOOLS } from './fixtures/upstream.js';

const PROXY_PATH = fileURLToPath(new URL('../index.js', import.meta.url));
const UPSTREAM_PATH = fileURLToPath(new URL('./fixtures/upstream.js', import.meta.url));

// Connects `server` to a new client over an in-memory pair.
async function clientFor(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

// agent client -> proxy -> fake upstream, all in-process. Also returns a
// client talking to the upstream directly, to compare against.
async function setup() {
  const upstream = await clientFor(createUpstream());
  const viaProxy = await clientFor(createProxy(upstream));
  const direct = await clientFor(createUpstream());
  return { viaProxy, direct };
}

// --- argument parsing ---

test('parseProxyArgs takes the server argv after --', () => {
  assert.deepEqual(parseProxyArgs(['--', 'node', 'server.js', '--flag']), { command: ['node', 'server.js', '--flag'] });
});

test('parseProxyArgs rejects a missing --, a missing command, or options', () => {
  assert.throws(() => parseProxyArgs(['node', 'server.js']), /missing "--"/);
  assert.throws(() => parseProxyArgs(['--']), /missing MCP server command/);
  assert.throws(() => parseProxyArgs(['--verbose', '--', 'node']), /unknown option "--verbose"/);
});

// --- passthrough, in-process ---

test('tools/list is forwarded unchanged', async () => {
  const { viaProxy, direct } = await setup();
  assert.deepEqual(await viaProxy.listTools(), await direct.listTools());
  assert.deepEqual((await viaProxy.listTools()).tools, TOOLS);
});

test('tools/call results are forwarded unchanged', async () => {
  const { viaProxy, direct } = await setup();
  const calls = [
    { name: 'echo', arguments: { b: 2, a: 'x' } },
    { name: 'fail', arguments: {} },
    { name: 'picture', arguments: {} },
  ];
  for (const call of calls) {
    assert.deepEqual(await viaProxy.callTool(call), await direct.callTool(call));
  }
});

test('an isError result stays a result, with isError: true', async () => {
  const { viaProxy } = await setup();
  const result = await viaProxy.callTool({ name: 'fail', arguments: {} });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'disk on fire' }], isError: true });
});

test('a protocol error comes back with the same code and message', async () => {
  const { viaProxy, direct } = await setup();
  const errorOf = (client) => client.callTool({ name: 'nope', arguments: {} }).then(
    () => assert.fail('expected an error'),
    (err) => ({ code: err.code, message: err.message }),
  );
  const fromProxy = await errorOf(viaProxy);
  assert.deepEqual(fromProxy, await errorOf(direct));
  assert.match(fromProxy.message, /Unknown tool: nope/);
});

// --- the real entry point over stdio ---

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('over stdio: forwards calls, passes env through, and shuts the server down', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-'));
  const pidFile = path.join(dir, 'upstream.pid');
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [PROXY_PATH, '--', process.execPath, UPSTREAM_PATH],
    env: { REWIND_RUN_ID: 'run-123', PID_FILE: pidFile },
  }));

  assert.deepEqual((await client.listTools()).tools, TOOLS);
  const echoed = await client.callTool({ name: 'echo', arguments: { a: 'hi' } });
  assert.deepEqual(echoed.content, [{ type: 'text', text: '{"a":"hi"}' }]);
  // The proxy hands its whole environment to the real server.
  const env = await client.callTool({ name: 'env', arguments: {} });
  assert.equal(env.content[0].text, 'run-123');

  const upstreamPid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.ok(isAlive(upstreamPid));

  // Closing ends the proxy's stdin. It should exit on its own (well before
  // the SDK's 2-second kill timeout) and take the real server with it.
  const started = Date.now();
  await client.close();
  assert.ok(Date.now() - started < 1500, `proxy took ${Date.now() - started}ms to exit`);
  for (let i = 0; i < 20 && isAlive(upstreamPid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isAlive(upstreamPid), false, 'the real MCP server is still running');
  await fs.rm(dir, { recursive: true, force: true });
});

test('over stdio: exits with an error when the server command does not exist', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PROXY_PATH, '--', 'no-such-mcp-server-xyz'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  await assert.rejects(client.connect(transport));
  assert.match(stderr, /could not start the MCP server "no-such-mcp-server-xyz"/);
});
