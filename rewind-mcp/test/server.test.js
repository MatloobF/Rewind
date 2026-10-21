import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRewindServer } from '../src/server.js';

const INDEX_PATH = fileURLToPath(new URL('../index.js', import.meta.url));

// A fake Rewind API: answers GET <path> with routes[path] -> { status, body }.
async function fakeApi(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    const reply = routes[req.url] ?? { status: 404, body: { error: 'not found' } };
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// An MCP client connected in-process to a Rewind MCP server.
async function clientFor(serverUrl) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createRewindServer({ serverUrl }).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function run(id, status, extra = {}) {
  return {
    id, name: `run ${id}`, status, command: ['node', 'agent.js'], cwd: 'C:/somewhere',
    created_at: '2026-10-18T00:00:00.000Z', parent_run_id: null, fork_step: null,
    fork_override: null, diverged_at_step: null,
    step_count: 3, tokens_in: 100, tokens_out: 20, latency_ms: 900, ...extra,
  };
}

const RUNS = [run('a', 'failed'), run('b', 'success'), run('c', 'failed'), run('d', 'running')];

const parse = (result) => JSON.parse(result.content[0].text);

test('tools/list shows list_runs with its input schema', async () => {
  const client = await clientFor('http://127.0.0.1:1');
  const { tools } = await client.listTools();
  const listRuns = tools.find((t) => t.name === 'list_runs');
  assert.ok(listRuns);
  assert.deepEqual(Object.keys(listRuns.inputSchema.properties).sort(), ['limit', 'status']);
  assert.deepEqual(listRuns.inputSchema.properties.status.enum, ['running', 'success', 'failed']);
});

test('list_runs returns runs trimmed to the summary fields', async () => {
  const api = await fakeApi({
    '/api/runs': { status: 200, body: [run('a', 'failed', { fork_override: { kind: 'response', response: 'big' } })] },
  });
  const client = await clientFor(api.url);
  const result = await client.callTool({ name: 'list_runs', arguments: {} });
  assert.equal(result.isError, undefined);
  const [summary] = parse(result);
  assert.equal(summary.id, 'a');
  assert.equal(summary.step_count, 3);
  assert.deepEqual(summary.command, ['node', 'agent.js']);
  assert.equal('cwd' in summary, false);
  assert.equal('fork_override' in summary, false);
  assert.deepEqual(api.calls, ['/api/runs']);
});

test('list_runs filters by status and keeps the API order', async () => {
  const api = await fakeApi({ '/api/runs': { status: 200, body: RUNS } });
  const client = await clientFor(api.url);
  const result = await client.callTool({ name: 'list_runs', arguments: { status: 'failed' } });
  assert.deepEqual(parse(result).map((r) => r.id), ['a', 'c']);
});

test('list_runs returns at most limit runs, 20 by default', async () => {
  const many = Array.from({ length: 30 }, (_, i) => run(`r${i}`, 'success'));
  const api = await fakeApi({ '/api/runs': { status: 200, body: many } });
  const client = await clientFor(api.url);
  assert.equal(parse(await client.callTool({ name: 'list_runs', arguments: {} })).length, 20);
  const two = parse(await client.callTool({ name: 'list_runs', arguments: { limit: 2 } }));
  assert.deepEqual(two.map((r) => r.id), ['r0', 'r1']);
});

test('list_runs rejects a limit out of range without calling the API', async () => {
  const api = await fakeApi({ '/api/runs': { status: 200, body: RUNS } });
  const client = await clientFor(api.url);
  for (const limit of [0, 500, 2.5]) {
    const result = await client.callTool({ name: 'list_runs', arguments: { limit } });
    assert.equal(result.isError, true, `limit ${limit}`);
  }
  assert.deepEqual(api.calls, []);
});

// A URL with nothing listening: a port that was free a moment ago. (Not a
// fixed low port like 1, which fetch refuses as a "bad port" without trying.)
async function closedPortUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('list_runs says the server is not reachable when the API is down', async () => {
  const url = await closedPortUrl();
  const client = await clientFor(url);
  const result = await client.callTool({ name: 'list_runs', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, `Rewind server not reachable at ${url} (ECONNREFUSED). Is it running?`);
});

test('list_runs passes on the API error text', async () => {
  const api = await fakeApi({ '/api/runs': { status: 500, body: { error: 'database is down' } } });
  const client = await clientFor(api.url);
  const result = await client.callTool({ name: 'list_runs', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'GET /api/runs failed with 500: database is down');
});

// Over real stdio, any stray console.log would corrupt the protocol and
// this would fail (Rule 4).
test('index.js serves list_runs over stdio, reading REWIND_SERVER_URL', async () => {
  const api = await fakeApi({ '/api/runs': { status: 200, body: RUNS } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_PATH],
    env: { ...process.env, REWIND_SERVER_URL: `${api.url}/` },
    stderr: 'ignore',
  }));
  try {
    const result = await client.callTool({ name: 'list_runs', arguments: { status: 'running' } });
    assert.deepEqual(parse(result).map((r) => r.id), ['d']);
  } finally {
    await client.close();
  }
});
