import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProxy } from '../src/proxy.js';
import { createRecorder } from '../src/recorder.js';
import { createUpstream } from './fixtures/upstream.js';

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const PROXY_PATH = fileURLToPath(new URL('../index.js', import.meta.url));
const UPSTREAM_PATH = fileURLToPath(new URL('./fixtures/upstream.js', import.meta.url));

// A fake Rewind API. It saves every request it gets in `calls` and answers
// with `respond(method, path)` -> { status, body }, by default the way the
// real server does for a live step.
async function fakeApi(respond = defaultRespond) {
  const calls = [];
  let nextIdx = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, path: req.url, body: JSON.parse(raw) });
    const reply = respond(req.method, req.url, () => nextIdx++);
    if (!reply) return; // never answer (to test the timeout)
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  servers.push(server);
  return { url, calls };
}

function defaultRespond(method, path, nextIdx) {
  if (method === 'POST') return { status: 201, body: { idx: nextIdx(), mode: 'live' } };
  return { status: 200, body: {} };
}

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function clientFor(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

// agent client -> recording proxy -> fake upstream, in-process.
async function recordingProxy(serverUrl, options = {}) {
  const logs = [];
  const recorder = createRecorder({ runId: RUN_ID, serverUrl, log: (m) => logs.push(m), ...options });
  const upstream = await clientFor(createUpstream());
  const client = await clientFor(createProxy(upstream, { recorder }));
  return { client, logs };
}

const stepsPath = `/api/runs/${RUN_ID}/steps`;

test('a tool call is started, then finished with its result', async () => {
  const api = await fakeApi();
  const { client } = await recordingProxy(api.url);

  const result = await client.callTool({ name: 'echo', arguments: { a: 'x' } });
  assert.deepEqual(result.content, [{ type: 'text', text: '{"a":"x"}' }]);

  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[0], {
    method: 'POST',
    path: stepsPath,
    body: { type: 'tool', request: { name: 'echo', arguments: { a: 'x' } } },
  });
  const finish = api.calls[1];
  assert.equal(finish.method, 'PATCH');
  assert.equal(finish.path, `${stepsPath}/0`);
  assert.deepEqual(finish.body.response, result);
  assert.equal(finish.body.error, null);
  assert.ok(Number.isInteger(finish.body.latency_ms) && finish.body.latency_ms >= 0);
});

test('steps use the idx the server returns', async () => {
  const api = await fakeApi();
  const { client } = await recordingProxy(api.url);
  await client.callTool({ name: 'echo', arguments: {} });
  await client.callTool({ name: 'echo', arguments: {} });
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [
    `POST ${stepsPath}`, `PATCH ${stepsPath}/0`, `POST ${stepsPath}`, `PATCH ${stepsPath}/1`,
  ]);
});

test('missing arguments are recorded as {}', async () => {
  const api = await fakeApi();
  const { client } = await recordingProxy(api.url);
  await client.callTool({ name: 'echo' });
  assert.deepEqual(api.calls[0].body.request, { name: 'echo', arguments: {} });
});

test('an isError result is recorded with its text in error (Rule 5)', async () => {
  const api = await fakeApi();
  const { client } = await recordingProxy(api.url);
  const result = await client.callTool({ name: 'fail', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(api.calls[1].body.response, result);
  assert.equal(api.calls[1].body.error, 'disk on fire');
});

test('a protocol error is recorded with no response, and still reaches the agent unchanged', async () => {
  const api = await fakeApi();
  const { client } = await recordingProxy(api.url);
  const direct = await clientFor(createUpstream());
  const errorOf = (c) => c.callTool({ name: 'nope', arguments: {} }).then(
    () => assert.fail('expected an error'),
    (err) => ({ code: err.code, message: err.message }),
  );
  const fromProxy = await errorOf(client);
  assert.deepEqual(fromProxy, await errorOf(direct));

  // Recorded as "MCP error <code>: <message the server sent>". The fixture
  // throws an McpError, whose message already starts with that prefix, so
  // it shows twice here, exactly as a direct client sees it.
  assert.equal(api.calls[1].body.response, undefined);
  assert.equal(api.calls[1].body.error, fromProxy.message);
  assert.match(api.calls[1].body.error, /^MCP error -32602: .*Unknown tool: nope$/);
});

test('tools/list is not recorded', async () => {
  const api = await fakeApi();
  const { client } = await recordingProxy(api.url);
  await client.listTools();
  assert.equal(api.calls.length, 0);
});

// --- fail-open: recording problems never change what the agent gets ---

test('Rewind API down: the call still goes through, and the problem is logged', async () => {
  const api = await fakeApi();
  servers.pop().close(); // free the port, so nothing is listening there
  const { client, logs } = await recordingProxy(api.url);
  const result = await client.callTool({ name: 'echo', arguments: { a: 1 } });
  assert.deepEqual(result.content, [{ type: 'text', text: '{"a":1}' }]);
  assert.match(logs.join('\n'), /could not record tool call "echo": ECONNREFUSED/);
});

test('run not running (409): the call still goes through and nothing is finished', async () => {
  const api = await fakeApi((method) => method === 'POST'
    ? { status: 409, body: { error: `run ${RUN_ID} is success, not running` } }
    : { status: 200, body: {} });
  const { client, logs } = await recordingProxy(api.url);
  const result = await client.callTool({ name: 'echo', arguments: {} });
  assert.deepEqual(result.content, [{ type: 'text', text: '{}' }]);
  assert.equal(api.calls.length, 1); // POST only, no PATCH
  assert.match(logs.join('\n'), /409 run .* is success, not running/);
});

test('finish fails: the result still reaches the agent, and the problem is logged', async () => {
  const api = await fakeApi((method, path, nextIdx) => method === 'POST'
    ? { status: 201, body: { idx: nextIdx(), mode: 'live' } }
    : { status: 500, body: { error: 'database exploded' } });
  const { client, logs } = await recordingProxy(api.url);
  const result = await client.callTool({ name: 'echo', arguments: {} });
  assert.deepEqual(result.content, [{ type: 'text', text: '{}' }]);
  assert.match(logs.join('\n'), /could not save the result of step 0: 500 database exploded/);
});

test('a hung Rewind API times out instead of stalling the agent', async () => {
  const api = await fakeApi(() => null);
  const { client, logs } = await recordingProxy(api.url, { timeoutMs: 100 });
  const result = await client.callTool({ name: 'echo', arguments: {} });
  assert.deepEqual(result.content, [{ type: 'text', text: '{}' }]);
  assert.match(logs.join('\n'), /could not record tool call "echo"/);
});

test('a mode other than live is logged and the tool is called live', async () => {
  const api = await fakeApi((method, path, nextIdx) => method === 'POST'
    ? { status: 201, body: { idx: nextIdx(), mode: 'replay' } }
    : { status: 200, body: {} });
  const { client, logs } = await recordingProxy(api.url);
  const result = await client.callTool({ name: 'echo', arguments: {} });
  assert.deepEqual(result.content, [{ type: 'text', text: '{}' }]);
  assert.match(logs.join('\n'), /mode "replay" is not supported yet/);
  assert.equal(api.calls[1].method, 'PATCH');
});

// --- the real entry point: env vars turn recording on ---

test('over stdio: REWIND_RUN_ID and REWIND_SERVER_URL turn recording on', async () => {
  const api = await fakeApi();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [PROXY_PATH, '--', process.execPath, UPSTREAM_PATH],
    env: { REWIND_RUN_ID: RUN_ID, REWIND_SERVER_URL: `${api.url}/` }, // trailing slash is trimmed
    stderr: 'ignore',
  }));
  try {
    await client.callTool({ name: 'echo', arguments: { a: 'hi' } });
  } finally {
    await client.close();
  }
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [`POST ${stepsPath}`, `PATCH ${stepsPath}/0`]);
});

test('over stdio: without REWIND_RUN_ID nothing is recorded', async () => {
  const api = await fakeApi();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [PROXY_PATH, '--', process.execPath, UPSTREAM_PATH],
    env: { REWIND_SERVER_URL: api.url },
    stderr: 'ignore',
  }));
  try {
    await client.callTool({ name: 'echo', arguments: {} });
  } finally {
    await client.close();
  }
  assert.equal(api.calls.length, 0);
});
