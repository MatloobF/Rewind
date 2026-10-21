// Streaming through the LLM proxy (stream: true). A fake upstream sends SSE
// chunks and can pause or break off mid-stream. Postgres must be up.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { createRun, setRunStatus } from '../src/runs.js';
import { startStep, finishStep } from '../src/steps.js';
import { createSseParser, createChatAssembler } from '../src/sse.js';

const TEST_NAME = 'proxy-stream-test';

// How the fake upstream answers next:
//   chunks  strings written one by one (else `body` is sent whole)
//   pause   a promise awaited after the first chunk
//   drop    break the connection instead of ending the response
let reply;
let received;

const upstream = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  received = Buffer.concat(parts).toString('utf8');
  res.writeHead(reply.status, { 'content-type': reply.contentType });
  if (!reply.chunks) return res.end(reply.body);
  for (const [i, chunk] of reply.chunks.entries()) {
    // Wait until the chunk is sent, so a drop comes after it, not before.
    await new Promise((resolve) => res.write(chunk, resolve));
    if (i === 0 && reply.pause) await reply.pause;
  }
  if (reply.drop) res.destroy();
  else res.end();
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
  server = http.createServer(createApp({ upstreamUrl: await listen(upstream) }));
  baseUrl = await listen(server);
});

after(async () => {
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
  server.close();
  upstream.close();
  await pool.end();
});

const meta = { id: 'chatcmpl-s', object: 'chat.completion.chunk', created: 1700000000, model: 'rewind-qwen' };
const event = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };

// "Hello" in three deltas, a finish chunk, a usage chunk, [DONE].
const helloChunks = [
  event({ ...meta, choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }] }),
  event({ ...meta, choices: [{ index: 0, delta: { content: 'll' }, finish_reason: null }] }),
  event({ ...meta, choices: [{ index: 0, delta: { content: 'o' }, finish_reason: null }] }),
  event({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  event({ ...meta, choices: [], usage }),
  'data: [DONE]\n\n',
];

const helloResponse = {
  id: 'chatcmpl-s',
  object: 'chat.completion',
  created: 1700000000,
  model: 'rewind-qwen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  usage,
};

const streamRequest = {
  model: 'rewind-qwen',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  stream_options: { include_usage: true },
};

beforeEach(() => {
  received = undefined;
  reply = { status: 200, contentType: 'text/event-stream', chunks: helloChunks };
});

async function newRun() {
  const res = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.' }),
  });
  return (await res.json()).id;
}

function chat(runId, request, options = {}) {
  return fetch(`${baseUrl}/r/${runId}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...options,
  });
}

async function stepsOf(runId) {
  const { rows } = await pool.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY idx', [runId]);
  return rows;
}

// The step is finished just after the agent's stream ends (or breaks), so
// wait for the row rather than assume it is there.
async function finishedStep(runId) {
  for (let tries = 0; tries < 100; tries++) {
    const [step] = await stepsOf(runId);
    if (step && (step.response != null || step.error != null)) return step;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('step was never finished');
}

// Reads from a body reader until at least `length` characters have come.
async function readAtLeast(reader, length) {
  const decoder = new TextDecoder();
  let text = '';
  while (text.length < length) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('forwards each chunk as it arrives, before upstream has finished', async () => {
  // Upstream holds the rest of the answer until the agent has read chunk 1.
  // A proxy that buffered the whole stream would never deliver it: deadlock,
  // and the test times out.
  let release;
  reply.pause = new Promise((resolve) => { release = resolve; });

  const runId = await newRun();
  const res = await chat(runId, streamRequest);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);

  const reader = res.body.getReader();
  assert.equal(await readAtLeast(reader, helloChunks[0].length), helloChunks[0]);
  // Nothing recorded yet: the stream is still going.
  assert.equal((await stepsOf(runId))[0].response, null);

  release();
  const rest = await readAtLeast(reader, Infinity);
  assert.equal(helloChunks[0] + rest, helloChunks.join(''));
});

test('the agent gets the exact upstream bytes, and the request is forwarded unchanged', async () => {
  const runId = await newRun();
  const res = await chat(runId, streamRequest);
  assert.equal(await res.text(), helloChunks.join(''));
  assert.deepEqual(JSON.parse(received), streamRequest);
});

test('records the rebuilt response in the non-streaming shape, with tokens', async () => {
  const runId = await newRun();
  await (await chat(runId, streamRequest)).text();

  const step = await finishedStep(runId);
  assert.deepEqual(step.request, streamRequest);
  assert.deepEqual(step.response, helloResponse);
  assert.equal(step.error, null);
  assert.equal(step.tokens_in, 12);
  assert.equal(step.tokens_out, 3);
  assert.ok(Number.isInteger(step.latency_ms));
});

test('without include_usage there are no token counts', async () => {
  reply.chunks = helloChunks.filter((chunk) => !chunk.includes('"usage"'));
  const runId = await newRun();
  await (await chat(runId, { ...streamRequest, stream_options: undefined })).text();

  const step = await finishedStep(runId);
  assert.equal(step.response.choices[0].message.content, 'Hello');
  assert.equal('usage' in step.response, false);
  assert.equal(step.tokens_in, null);
  assert.equal(step.tokens_out, null);
});

test('an error status for a streaming request is passed through as JSON', async () => {
  reply = { status: 404, contentType: 'application/json', body: '{"error":{"message":"model not found"}}' };
  const runId = await newRun();
  const res = await chat(runId, streamRequest);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), reply.body);

  const step = await finishedStep(runId);
  assert.equal(step.error, 'upstream HTTP 404: model not found');
});

test('an upstream that breaks off mid-stream breaks the agent stream too, and is recorded', async () => {
  reply.chunks = helloChunks.slice(0, 2);
  reply.drop = true;
  const runId = await newRun();
  const res = await chat(runId, streamRequest);
  await assert.rejects(res.text());

  const step = await finishedStep(runId);
  assert.match(step.error, /^upstream stream failed/);
  // What arrived before the break is kept.
  assert.equal(step.response.choices[0].message.content, 'Hell');
});

test('an agent that hangs up mid-stream is recorded', async () => {
  let release;
  reply.pause = new Promise((resolve) => { release = resolve; });
  const runId = await newRun();
  const abort = new AbortController();
  const res = await chat(runId, streamRequest, { signal: abort.signal });
  await readAtLeast(res.body.getReader(), helloChunks[0].length);

  abort.abort();
  // Give the proxy a moment to see the closed connection, then let upstream go on.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();

  const step = await finishedStep(runId);
  assert.equal(step.error, 'agent disconnected mid-stream');
  assert.equal(step.response.choices[0].message.content, 'He');
});

// --- Fork runs: a streaming agent still gets streams back ---

// The parent was recorded without streaming; the fork's agent streams. The
// hash ignores `stream`, so the requests still match.
const plainRequest = { model: 'rewind-qwen', messages: [{ role: 'user', content: 'hi' }] };
const moreRequest = { model: 'rewind-qwen', messages: [{ role: 'user', content: 'more' }] };
const parentAnswer = {
  id: 'chatcmpl-parent',
  object: 'chat.completion',
  created: 1600000000,
  model: 'rewind-qwen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'from the parent' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

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

// Reads a whole SSE response and rebuilds the answer the agent's SDK would see.
async function readStream(res) {
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const parser = createSseParser();
  const assembler = createChatAssembler();
  const events = [...parser.push(new Uint8Array(await res.arrayBuffer())), ...parser.end()];
  for (const { data } of events) assembler.add(data);
  return assembler.result();
}

test('a replayed step is streamed to a streaming agent, without calling upstream', async () => {
  const parent = await recordParent([
    { request: plainRequest, result: { response: parentAnswer } },
    { request: moreRequest, result: { response: parentAnswer } },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await chat(runId, streamRequest);
  assert.equal(res.status, 200);
  // include_usage was asked for, so usage comes along.
  assert.deepEqual(await readStream(res), { response: parentAnswer, error: null });
  assert.equal(received, undefined);
  assert.equal((await stepsOf(runId))[0].replayed, true);

  // Without include_usage, no usage chunk.
  const runId2 = await forkOf(parent, 1);
  const { response } = await readStream(await chat(runId2, { ...plainRequest, stream: true }));
  assert.equal('usage' in response, false);
  assert.equal(response.choices[0].message.content, 'from the parent');
});

test('a replayed error stays JSON with its status, even for a streaming agent', async () => {
  const errorBody = { error: { message: 'model "nope" not found' } };
  const parent = await recordParent([
    { request: plainRequest, result: { response: errorBody, error: 'upstream HTTP 404: model "nope" not found' } },
    { request: moreRequest, result: { response: parentAnswer } },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await chat(runId, streamRequest);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), errorBody);
});

test('a response override is streamed to a streaming agent', async () => {
  const parent = await recordParent([{ request: plainRequest, result: { response: parentAnswer } }]);
  const edited = {
    ...parentAnswer,
    choices: [{ index: 0, message: { role: 'assistant', content: 'edited' }, finish_reason: 'stop' }],
  };
  const runId = await forkOf(parent, 0, { kind: 'response', response: edited });

  const { response } = await readStream(await chat(runId, streamRequest));
  assert.equal(response.choices[0].message.content, 'edited');
  assert.equal(received, undefined);
});

test('a request override is sent with the agent\'s stream fields and relayed as a stream', async () => {
  const parent = await recordParent([{ request: plainRequest, result: { response: parentAnswer } }]);
  // The edit came from the non-streaming parent: no stream fields.
  const edited = { ...plainRequest, model: 'other-model' };
  const runId = await forkOf(parent, 0, { kind: 'request', request: edited });

  const res = await chat(runId, streamRequest);
  assert.equal(await res.text(), helloChunks.join(''));
  const sent = { ...edited, stream: true, stream_options: { include_usage: true } };
  assert.deepEqual(JSON.parse(received), sent);

  const step = await finishedStep(runId);
  assert.deepEqual(step.request, sent);
  assert.deepEqual(step.response, helloResponse);
});

test('a streaming fork that diverges goes live and streams from upstream', async () => {
  const parent = await recordParent([
    { request: plainRequest, result: { response: parentAnswer } },
    { request: moreRequest, result: { response: parentAnswer } },
  ]);
  const runId = await forkOf(parent, 1);

  // Step 0 asks something else than the parent did.
  const res = await chat(runId, { ...streamRequest, messages: [{ role: 'user', content: 'different' }] });
  assert.equal(await res.text(), helloChunks.join(''));
  assert.notEqual(received, undefined);

  const step = await finishedStep(runId);
  assert.equal(step.replayed, false);
  assert.deepEqual(step.response, helloResponse);
  const { rows } = await pool.query('SELECT diverged_at_step FROM runs WHERE id = $1', [runId]);
  assert.equal(rows[0].diverged_at_step, 0);
});
