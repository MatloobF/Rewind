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
async function clientFor(serverUrl, intelUrl = 'http://127.0.0.1:1') {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createRewindServer({ serverUrl, intelUrl }).connect(serverTransport);
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

const RUN_ID = '11111111-2222-3333-4444-555555555555';

test('tools/list shows get_run with a run_id input', async () => {
  const client = await clientFor('http://127.0.0.1:1');
  const { tools } = await client.listTools();
  const getRun = tools.find((t) => t.name === 'get_run');
  assert.ok(getRun);
  assert.deepEqual(getRun.inputSchema.required, ['run_id']);
});

test('get_run returns the run summary from GET /api/runs/:id', async () => {
  const api = await fakeApi({
    [`/api/runs/${RUN_ID}`]: { status: 200, body: { ...run(RUN_ID, 'success'), steps: [] } },
  });
  const client = await clientFor(api.url);
  const result = await client.callTool({ name: 'get_run', arguments: { run_id: RUN_ID } });
  assert.equal(result.isError, undefined);
  const summary = parse(result);
  assert.equal(summary.run.id, RUN_ID);
  assert.deepEqual(summary.steps, []);
  assert.deepEqual(api.calls, [`/api/runs/${RUN_ID}`]);
});

test('get_run passes on the API 404 for an unknown run', async () => {
  const api = await fakeApi({
    [`/api/runs/${RUN_ID}`]: { status: 404, body: { error: `run ${RUN_ID} not found` } },
  });
  const client = await clientFor(api.url);
  const result = await client.callTool({ name: 'get_run', arguments: { run_id: RUN_ID } });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, `GET /api/runs/${RUN_ID} failed with 404: run ${RUN_ID} not found`);
});

test('get_run rejects a run_id that is not a UUID without calling the API', async () => {
  const api = await fakeApi({});
  const client = await clientFor(api.url);
  for (const run_id of ['abc', '../evals', '']) {
    const result = await client.callTool({ name: 'get_run', arguments: { run_id } });
    assert.equal(result.isError, true, `run_id ${JSON.stringify(run_id)}`);
  }
  assert.deepEqual(api.calls, []);
});

// A failure from the intel service's GET /failures, as it appears inside a pattern.
function failure(runId, message) {
  return {
    run_id: runId, run_name: `run ${runId}`, idx: 3, type: 'tool', tool: 'read_file',
    source: 'step_error', message, signature: 'Not found: <value>',
  };
}

function pattern(id, size) {
  return {
    id, kind: 'cluster', label: `label ${id}`, size, run_count: size,
    signatures: Array.from({ length: 7 }, (_, i) => ({ signature: `sig ${i}`, count: 7 - i })),
    failures: Array.from({ length: size }, (_, i) => failure(`r${i}`, `Not found: file${i}.txt`)),
  };
}

test('get_failure_patterns trims each pattern to top signatures and a few examples', async () => {
  const intel = await fakeApi({
    '/failures/clusters': { status: 200, body: { patterns: [pattern(0, 6), pattern(1, 2)] } },
  });
  const client = await clientFor('http://127.0.0.1:1', intel.url);
  const result = await client.callTool({ name: 'get_failure_patterns', arguments: {} });
  assert.equal(result.isError, undefined);
  const { total_patterns, patterns } = parse(result);
  assert.equal(total_patterns, 2);
  assert.equal(patterns.length, 2);
  const [first] = patterns;
  assert.deepEqual(
    { id: first.id, kind: first.kind, label: first.label, size: first.size, run_count: first.run_count },
    { id: 0, kind: 'cluster', label: 'label 0', size: 6, run_count: 6 },
  );
  assert.equal(first.signatures.length, 5);
  assert.deepEqual(first.signatures[0], { signature: 'sig 0', count: 7 });
  assert.equal(first.examples.length, 3);
  assert.deepEqual(first.examples[0], {
    run_id: 'r0', run_name: 'run r0', idx: 3, type: 'tool', tool: 'read_file', message: 'Not found: file0.txt',
  });
  assert.equal('failures' in first, false);
  assert.deepEqual(intel.calls, ['/failures/clusters']);
});

test('get_failure_patterns returns at most limit patterns and says how many there are', async () => {
  const many = Array.from({ length: 12 }, (_, i) => pattern(i, 1));
  const intel = await fakeApi({ '/failures/clusters': { status: 200, body: { patterns: many } } });
  const client = await clientFor('http://127.0.0.1:1', intel.url);
  const byDefault = parse(await client.callTool({ name: 'get_failure_patterns', arguments: {} }));
  assert.equal(byDefault.total_patterns, 12);
  assert.equal(byDefault.patterns.length, 10);
  const two = parse(await client.callTool({ name: 'get_failure_patterns', arguments: { limit: 2 } }));
  assert.deepEqual(two.patterns.map((p) => p.id), [0, 1]);
});

test('get_failure_patterns clips long example messages', async () => {
  const big = pattern(0, 1);
  big.failures[0].message = 'e'.repeat(300);
  const intel = await fakeApi({ '/failures/clusters': { status: 200, body: { patterns: [big] } } });
  const client = await clientFor('http://127.0.0.1:1', intel.url);
  const { patterns } = parse(await client.callTool({ name: 'get_failure_patterns', arguments: {} }));
  assert.equal(patterns[0].examples[0].message, `${'e'.repeat(200)}… (+100 chars)`);
});

test('get_run_loops returns the intel service answer for the run', async () => {
  const loops = {
    run_id: RUN_ID,
    loops: [{ kind: 'tool_cycle', tools: ['list_files'], period: 1, repeats: 4, step_idxs: [1, 3, 5, 7] }],
  };
  const intel = await fakeApi({ [`/runs/${RUN_ID}/loops`]: { status: 200, body: loops } });
  const client = await clientFor('http://127.0.0.1:1', intel.url);
  const result = await client.callTool({ name: 'get_run_loops', arguments: { run_id: RUN_ID } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(parse(result), loops);
});

test('get_run_loops passes on the FastAPI 404 detail for an unknown run', async () => {
  const intel = await fakeApi({ [`/runs/${RUN_ID}/loops`]: { status: 404, body: { detail: 'run not found' } } });
  const client = await clientFor('http://127.0.0.1:1', intel.url);
  const result = await client.callTool({ name: 'get_run_loops', arguments: { run_id: RUN_ID } });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, `GET /runs/${RUN_ID}/loops failed with 404: run not found`);
});

test('get_run_loops rejects a run_id that is not a UUID without calling intel', async () => {
  const intel = await fakeApi({});
  const client = await clientFor('http://127.0.0.1:1', intel.url);
  const result = await client.callTool({ name: 'get_run_loops', arguments: { run_id: 'abc' } });
  assert.equal(result.isError, true);
  assert.deepEqual(intel.calls, []);
});

test('with the intel service down, its tools say so and the run tools still work', async () => {
  const api = await fakeApi({ '/api/runs': { status: 200, body: RUNS } });
  const intelUrl = await closedPortUrl();
  const client = await clientFor(api.url, intelUrl);
  for (const [name, args] of [['get_failure_patterns', {}], ['get_run_loops', { run_id: RUN_ID }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.equal(result.content[0].text, `Rewind intel service not reachable at ${intelUrl} (ECONNREFUSED). Is it running?`);
  }
  const runs = await client.callTool({ name: 'list_runs', arguments: {} });
  assert.equal(runs.isError, undefined);
  assert.equal(parse(runs).length, RUNS.length);
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
