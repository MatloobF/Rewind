// LLM proxy tests. A tiny fake upstream stands in for Ollama, so these run
// in milliseconds and don't need a model. Postgres must be up.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { hashRequest } from '../src/hash.js';
import { createRun, setRunStatus } from '../src/runs.js';
import { startStep, finishStep } from '../src/steps.js';

const TEST_NAME = 'proxy-test';

// What the fake upstream received last, and how it should answer next.
let received;
let reply;

const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
  res.writeHead(reply.status, { 'content-type': reply.contentType });
  res.end(reply.body);
});

let server;
let baseUrl;

const listen = async (srv) => {
  srv.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  return `http://localhost:${srv.address().port}`;
};

before(async () => {
  await migrate();
  const upstreamUrl = await listen(upstream);
  // The trailing slash checks that the proxy strips it.
  server = http.createServer(createApp({ upstreamUrl: `${upstreamUrl}/` }));
  baseUrl = await listen(server);
});

after(async () => {
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
  server.close();
  upstream.close();
  await pool.end();
});

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
};

beforeEach(() => {
  received = undefined;
  reply = { status: 200, contentType: 'application/json', body: JSON.stringify(completion) };
});

async function newRun() {
  const res = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.' }),
  });
  return (await res.json()).id;
}

function chat(runId, rawBody, headers = {}) {
  return fetch(`${baseUrl}/r/${runId}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

async function stepsOf(runId) {
  const { rows } = await pool.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY idx', [runId]);
  return rows;
}

test('forwards the exact request bytes and returns the upstream reply unchanged', async () => {
  const runId = await newRun();
  // Odd key order and spacing: a re-serialized body would not match.
  const rawBody = '{ "temperature":0,  "model":"rewind-qwen","messages":[{"role":"user","content":"hi"}] }';
  const res = await chat(runId, rawBody, { authorization: 'Bearer sk-test' });

  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.body, rawBody);
  assert.equal(received.headers.authorization, 'Bearer sk-test');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(await res.text(), reply.body);
});

test('records the call as one finished llm step', async () => {
  const runId = await newRun();
  const request = { model: 'rewind-qwen', messages: [{ role: 'user', content: 'hi' }] };
  await chat(runId, JSON.stringify(request));

  const [step, ...rest] = await stepsOf(runId);
  assert.equal(rest.length, 0);
  assert.equal(step.idx, 0);
  assert.equal(step.type, 'llm');
  assert.deepEqual(step.request, request);
  assert.equal(step.request_hash, hashRequest(request));
  assert.deepEqual(step.response, completion);
  assert.equal(step.error, null);
  assert.equal(step.tokens_in, 42);
  assert.equal(step.tokens_out, 7);
  assert.ok(Number.isInteger(step.latency_ms) && step.latency_ms >= 0);
  assert.equal(step.replayed, false);
});

test('consecutive calls get idx 0 and 1', async () => {
  const runId = await newRun();
  await chat(runId, '{"model":"m","messages":[]}');
  await chat(runId, '{"model":"m","messages":[{"role":"user","content":"again"}]}');
  assert.deepEqual((await stepsOf(runId)).map((s) => s.idx), [0, 1]);
});

test('an upstream error status is passed through and recorded', async () => {
  const runId = await newRun();
  reply = { status: 404, contentType: 'application/json', body: '{"error":{"message":"model \\"nope\\" not found"}}' };
  const res = await chat(runId, '{"model":"nope","messages":[]}');

  assert.equal(res.status, 404);
  assert.equal(await res.text(), reply.body);
  const [step] = await stepsOf(runId);
  assert.equal(step.error, 'upstream HTTP 404: model "nope" not found');
  assert.deepEqual(step.response, JSON.parse(reply.body));
});

test('a non-JSON upstream body is passed through and marked as an error', async () => {
  const runId = await newRun();
  reply = { status: 200, contentType: 'text/plain', body: 'hello' };
  const res = await chat(runId, '{"model":"m","messages":[]}');

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello');
  const [step] = await stepsOf(runId);
  assert.equal(step.response, null);
  assert.equal(step.error, 'upstream returned a non-JSON body');
});

test('an unreachable upstream gives 502 and a recorded error', async () => {
  // Port 1 is reserved and nothing listens there.
  const app = http.createServer(createApp({ upstreamUrl: 'http://127.0.0.1:1' }));
  const appUrl = await listen(app);
  try {
    const runId = await newRun();
    const res = await fetch(`${appUrl}/r/${runId}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /^upstream request failed/);
    const [step] = await stepsOf(runId);
    assert.match(step.error, /^upstream request failed/);
    assert.equal(step.response, null);
  } finally {
    app.close();
  }
});

test('streaming requests are refused before any step is created', async () => {
  const runId = await newRun();
  const res = await chat(runId, '{"model":"m","messages":[],"stream":true}');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /streaming/);
  assert.equal(received, undefined);
  assert.equal((await stepsOf(runId)).length, 0);
});

test('bad bodies and run ids are rejected without calling upstream', async () => {
  const runId = await newRun();
  assert.equal((await chat(runId, '{not json')).status, 400);
  assert.equal((await chat(runId, '[1,2]')).status, 400);
  assert.equal((await chat('not-a-uuid', '{"model":"m"}')).status, 400);
  assert.equal((await chat('00000000-0000-0000-0000-000000000000', '{"model":"m"}')).status, 404);
  assert.equal(received, undefined);
});

test('a finished run refuses more calls', async () => {
  const runId = await newRun();
  await fetch(`${baseUrl}/api/runs/${runId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: '{"status":"success"}',
  });
  assert.equal((await chat(runId, '{"model":"m","messages":[]}')).status, 409);
  assert.equal(received, undefined);
});

// --- Fork runs: the proxy follows the mode startStep returns ---

const askHi = { model: 'rewind-qwen', messages: [{ role: 'user', content: 'hi' }] };
const askMore = { model: 'rewind-qwen', messages: [{ role: 'user', content: 'more' }] };

// A finished parent run with the given llm steps, recorded through the store.
async function recordParent(steps) {
  const run = await createRun({ name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.' });
  for (const { request, result } of steps) {
    const { idx } = await startStep(run.id, { type: 'llm', request });
    await finishStep(run.id, idx, result);
  }
  await setRunStatus(run.id, 'success');
  return run;
}

async function forkOf(parent, forkStep, forkOverride = null) {
  const run = await createRun({
    name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.', parentRunId: parent.id, forkStep, forkOverride,
  });
  return run.id;
}

const parentAnswer = { ...completion, id: 'chatcmpl-parent' };

test('a fork replays the parent answer without calling upstream, then goes live', async () => {
  const parent = await recordParent([
    { request: askHi, result: { response: parentAnswer, tokens_in: 1, tokens_out: 1 } },
    { request: askMore, result: { response: parentAnswer } },
  ]);
  const runId = await forkOf(parent, 1);

  const replayed = await chat(runId, JSON.stringify(askHi));
  assert.equal(replayed.status, 200);
  assert.match(replayed.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await replayed.json(), parentAnswer);
  assert.equal(received, undefined);

  // Step 1 is the fork step with no override: a normal live call.
  const live = await chat(runId, JSON.stringify(askMore));
  assert.deepEqual(await live.json(), completion);
  assert.deepEqual(JSON.parse(received.body), askMore);

  const steps = await stepsOf(runId);
  assert.deepEqual(steps.map((s) => s.replayed), [true, false]);
  assert.deepEqual(steps[1].response, completion);
});

test('a replayed upstream error keeps its status and body', async () => {
  const errorBody = { error: { message: 'model "nope" not found' } };
  const parent = await recordParent([
    { request: askHi, result: { response: errorBody, error: 'upstream HTTP 404: model "nope" not found' } },
    { request: askMore, result: { response: parentAnswer } },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await chat(runId, JSON.stringify(askHi));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), errorBody);
  assert.equal(received, undefined);
});

test('a replayed failure with no body comes back as 502 with the recorded error', async () => {
  const parent = await recordParent([
    { request: askHi, result: { error: 'upstream request failed: ECONNREFUSED' } },
    { request: askMore, result: { response: parentAnswer } },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await chat(runId, JSON.stringify(askHi));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream request failed: ECONNREFUSED' });
  assert.equal(received, undefined);
});

test('a response override is sent back without calling upstream', async () => {
  const parent = await recordParent([{ request: askHi, result: { response: parentAnswer } }]);
  const edited = { ...completion, id: 'chatcmpl-edited' };
  const runId = await forkOf(parent, 0, { kind: 'response', response: edited });

  const res = await chat(runId, JSON.stringify(askHi));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), edited);
  assert.equal(received, undefined);
  const [step] = await stepsOf(runId);
  assert.deepEqual(step.response, edited);
});

test('a request override sends the edited request upstream and records the reply', async () => {
  const parent = await recordParent([{ request: askHi, result: { response: parentAnswer } }]);
  const edited = { ...askHi, model: 'other-model' };
  const runId = await forkOf(parent, 0, { kind: 'request', request: edited });

  const res = await chat(runId, JSON.stringify(askHi));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), completion);
  assert.deepEqual(JSON.parse(received.body), edited);

  const [step] = await stepsOf(runId);
  assert.deepEqual(step.request, edited);
  assert.deepEqual(step.response, completion);
  assert.equal(step.tokens_in, 42);
  assert.equal(step.replayed, false);
});
