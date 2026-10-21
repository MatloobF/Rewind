// Side routes under /r/:runId/v1/... that aren't recorded LLM calls, e.g.
// Claude Code's /v1/messages/count_tokens: passed through unchanged, no step.
// Two fake upstreams show which one a request went to. Postgres must be up.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { createRun } from '../src/runs.js';

const TEST_NAME = 'proxy-passthrough-test';

let received;
let reply;

// Records what it got and answers with `reply`, tagged with its own name.
function fakeUpstream(name) {
  return http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    received = {
      upstream: name, method: req.method, url: req.url, headers: req.headers,
      body: Buffer.concat(parts).toString('utf8'),
    };
    res.writeHead(reply.status, { 'content-type': 'application/json', 'x-upstream': name });
    res.end(reply.body);
  });
}

const openaiUpstream = fakeUpstream('openai');
const anthropicUpstream = fakeUpstream('anthropic');
let server;
let baseUrl;
let runId;

const listen = async (srv) => {
  srv.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  return `http://localhost:${srv.address().port}`;
};

before(async () => {
  await migrate();
  const upstreamUrl = await listen(openaiUpstream);
  const anthropicUpstreamUrl = await listen(anthropicUpstream);
  server = http.createServer(createApp({ upstreamUrl, anthropicUpstreamUrl }));
  baseUrl = await listen(server);
  runId = (await createRun({ name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.' })).id;
});

after(async () => {
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
  server.close();
  openaiUpstream.close();
  anthropicUpstream.close();
  await pool.end();
});

beforeEach(() => {
  received = undefined;
  reply = { status: 200, body: '{"input_tokens":42}' };
});

async function stepCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM steps WHERE run_id = $1', [runId]);
  return rows[0].n;
}

test('count_tokens goes to the Anthropic upstream unchanged and is not recorded', async () => {
  const body = '{"model":"claude-test","messages":[{"role":"user","content":"hi"}]}';
  const res = await fetch(`${baseUrl}/r/${runId}/v1/messages/count_tokens?beta=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      'x-api-key': 'test-key', 'anthropic-beta': 'token-counting-2024-11-01',
    },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"input_tokens":42}');
  assert.equal(received.upstream, 'anthropic');
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/messages/count_tokens?beta=true');
  assert.equal(received.body, body);
  assert.equal(received.headers['x-api-key'], 'test-key');
  assert.equal(received.headers['anthropic-beta'], 'token-counting-2024-11-01');
  assert.equal(await stepCount(), 0);
});

test('a request without anthropic-version goes to the OpenAI upstream', async () => {
  reply = { status: 200, body: '{"object":"list","data":[]}' };
  const res = await fetch(`${baseUrl}/r/${runId}/v1/models`, { headers: { authorization: 'Bearer x' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { object: 'list', data: [] });
  assert.equal(received.upstream, 'openai');
  assert.equal(received.method, 'GET');
  assert.equal(received.url, '/v1/models');
  assert.equal(received.headers.authorization, 'Bearer x');
  assert.equal(await stepCount(), 0);
});

test('an upstream error status is passed back unchanged', async () => {
  reply = { status: 404, body: '{"error":"not found"}' };
  const res = await fetch(`${baseUrl}/r/${runId}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: '{}',
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
  assert.equal(await stepCount(), 0);
});

test('the recorded routes still win over the passthrough', async () => {
  reply = { status: 200, body: JSON.stringify({ id: 'c1', object: 'chat.completion', choices: [] }) };
  const res = await fetch(`${baseUrl}/r/${runId}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"m","messages":[]}',
  });
  assert.equal(res.status, 200);
  assert.equal(received.upstream, 'openai');
  assert.equal(await stepCount(), 1);
});

test('a bad run id is a 400, as on the recorded routes', async () => {
  const res = await fetch(`${baseUrl}/r/not-a-uuid/v1/models`);
  assert.equal(res.status, 400);
  assert.equal(received, undefined);
});

test('an unreachable upstream is a 502 { error }', async () => {
  const app = createApp({ upstreamUrl: 'http://127.0.0.1:1', anthropicUpstreamUrl: 'http://127.0.0.1:1' });
  const down = http.createServer(app);
  const downUrl = await listen(down);
  try {
    const res = await fetch(`${downUrl}/r/${runId}/v1/models`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /^upstream request failed/);
  } finally {
    down.close();
  }
});
