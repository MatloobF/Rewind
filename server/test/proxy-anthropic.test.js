// The Anthropic-format route, POST /r/:runId/v1/messages, against a fake
// upstream (the real API or Ollama are never called). Postgres must be up.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { createRun, setRunStatus } from '../src/runs.js';
import { startStep, finishStep } from '../src/steps.js';
import { createSseParser, createMessageAssembler } from '../src/sse.js';

const TEST_NAME = 'proxy-anthropic-test';

let received;
let reply;

const upstream = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  received = { url: req.url, headers: req.headers, body: Buffer.concat(parts).toString('utf8') };
  res.writeHead(reply.status, { 'content-type': reply.contentType });
  if (!reply.chunks) return res.end(reply.body);
  for (const chunk of reply.chunks) await new Promise((resolve) => res.write(chunk, resolve));
  res.end();
});

let upstreamUrl;
let server;
let baseUrl;

const listen = async (srv) => {
  srv.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  return `http://localhost:${srv.address().port}`;
};

before(async () => {
  await migrate();
  upstreamUrl = await listen(upstream);
  // Both formats explicitly, so an ANTHROPIC_UPSTREAM_URL in .env can't
  // send test traffic to the real API.
  server = http.createServer(createApp({ upstreamUrl, anthropicUpstreamUrl: upstreamUrl }));
  baseUrl = await listen(server);
});

after(async () => {
  await pool.query('DELETE FROM runs WHERE name = $1', [TEST_NAME]);
  server.close();
  upstream.close();
  await pool.end();
});

const message = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [
    { type: 'text', text: 'Listing files.' },
    { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 25 },
};

const request = { model: 'claude-test', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] };

beforeEach(() => {
  received = undefined;
  reply = { status: 200, contentType: 'application/json', body: JSON.stringify(message) };
});

async function newRun() {
  return (await createRun({ name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.' })).id;
}

function messages(runId, rawBody, headers = {}, url = baseUrl) {
  return fetch(`${url}/r/${runId}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
}

async function stepsOf(runId) {
  const { rows } = await pool.query('SELECT * FROM steps WHERE run_id = $1 ORDER BY idx', [runId]);
  return rows;
}

test('forwards the exact bytes and Anthropic headers to /v1/messages, and the reply unchanged', async () => {
  const runId = await newRun();
  const rawBody = '{ "max_tokens":1024, "model":"claude-test","messages":[{"role":"user","content":"hi"}] }';
  const res = await messages(runId, rawBody, { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' });

  assert.equal(received.url, '/v1/messages');
  assert.equal(received.body, rawBody);
  assert.equal(received.headers['x-api-key'], 'sk-ant-test');
  assert.equal(received.headers['anthropic-version'], '2023-06-01');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), reply.body);
});

test('records an anthropic-format llm step, with cached prompt tokens counted in tokens_in', async () => {
  const runId = await newRun();
  await messages(runId, JSON.stringify(request), { 'x-api-key': 'sk-ant-test' });

  const [step] = await stepsOf(runId);
  assert.equal(step.type, 'llm');
  assert.equal(step.format, 'anthropic');
  assert.deepEqual(step.request, request);
  assert.deepEqual(step.response, message);
  assert.equal(step.error, null);
  assert.equal(step.tokens_in, 3210);
  assert.equal(step.tokens_out, 25);
  // The key went upstream but is nowhere in the row.
  assert.equal(JSON.stringify(step).includes('sk-ant-test'), false);
});

test('an Anthropic error is passed through and recorded', async () => {
  reply = {
    status: 400,
    contentType: 'application/json',
    body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}',
  };
  const runId = await newRun();
  const res = await messages(runId, '{"model":"claude-test","messages":[]}');
  assert.equal(res.status, 400);
  assert.equal(await res.text(), reply.body);
  const [step] = await stepsOf(runId);
  assert.equal(step.error, 'upstream HTTP 400: max_tokens: Field required');
});

test('each format goes to its own upstream', async () => {
  // OpenAI format to a just-closed port, Anthropic format to the fake upstream.
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  dead.close();
  const app = http.createServer(createApp({ upstreamUrl: deadUrl, anthropicUpstreamUrl: upstreamUrl }));
  const appUrl = await listen(app);
  try {
    const runId = await newRun();
    assert.equal((await messages(runId, JSON.stringify(request), {}, appUrl)).status, 200);
    assert.equal(received.url, '/v1/messages');

    const chat = await fetch(`${appUrl}/r/${runId}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    });
    assert.equal(chat.status, 502);
  } finally {
    app.close();
  }
});

// --- Forks ---

async function recordParent(steps) {
  const run = await createRun({ name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.' });
  for (const { format, response } of steps) {
    const { idx } = await startStep(run.id, { type: 'llm', format, request });
    await finishStep(run.id, idx, { response });
  }
  await setRunStatus(run.id, 'success');
  return run;
}

async function forkOf(parent, forkStep) {
  const run = await createRun({
    name: TEST_NAME, command: ['node', 'agent.js'], cwd: '.', parentRunId: parent.id, forkStep,
  });
  return run.id;
}

const parentMessage = { ...message, id: 'msg_parent' };

test('a fork replays an anthropic step without calling upstream', async () => {
  const parent = await recordParent([
    { format: 'anthropic', response: parentMessage },
    { format: 'anthropic', response: parentMessage },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await messages(runId, JSON.stringify(request));
  assert.deepEqual(await res.json(), parentMessage);
  assert.equal(received, undefined);
  const [step] = await stepsOf(runId);
  assert.equal(step.replayed, true);
  assert.equal(step.format, 'anthropic');
});

test('a step in another format is not replayed, even with the same request', async () => {
  // Same body, so the same hash: only the format tells them apart.
  const parent = await recordParent([
    { format: 'openai', response: { choices: [] } },
    { format: 'openai', response: { choices: [] } },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await messages(runId, JSON.stringify(request));
  assert.deepEqual(await res.json(), message);
  assert.notEqual(received, undefined);
  const { rows } = await pool.query('SELECT diverged_at_step FROM runs WHERE id = $1', [runId]);
  assert.equal(rows[0].diverged_at_step, 0);
});

test('tool steps have no format, and the database refuses a mismatch', async () => {
  const runId = await newRun();
  await startStep(runId, { type: 'tool', request: { name: 'list_files', arguments: {} } });
  const [step] = await stepsOf(runId);
  assert.equal(step.format, null);

  await assert.rejects(startStep(runId, { type: 'tool', format: 'openai', request: {} }), /check constraint/);
  await assert.rejects(startStep(runId, { type: 'llm', format: null, request: {} }), /check constraint/);
});

// --- Streaming (stream: true) ---

const sse = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

// The message above as the API streams it: text, then a tool call whose
// input arrives in two JSON pieces, with a ping in between.
const messageStream = [
  sse('message_start', { message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 1 },
  } }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Listing ' } }),
  sse('ping', {}),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'files.' } }),
  sse('content_block_stop', { index: 0 }),
  sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: {} } }),
  sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }),
  sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'th": "."}' } }),
  sse('content_block_stop', { index: 1 }),
  sse('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 25 } }),
  sse('message_stop', {}),
];

const streamRequest = { ...request, stream: true };

async function finishedStep(runId) {
  for (let tries = 0; tries < 100; tries++) {
    const [step] = await stepsOf(runId);
    if (step && (step.response != null || step.error != null)) return step;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('step was never finished');
}

// Reads a whole SSE response and rebuilds the message the agent's SDK would see.
async function readStream(res) {
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const parser = createSseParser();
  const assembler = createMessageAssembler();
  const events = [...parser.push(new Uint8Array(await res.arrayBuffer())), ...parser.end()];
  for (const { data } of events) assembler.add(data);
  return assembler.result();
}

test('a streamed message is forwarded unchanged and recorded in the non-streaming shape', async () => {
  reply = { status: 200, contentType: 'text/event-stream', chunks: messageStream };
  const runId = await newRun();
  const res = await messages(runId, JSON.stringify(streamRequest));
  assert.equal(await res.text(), messageStream.join(''));

  const step = await finishedStep(runId);
  assert.equal(step.format, 'anthropic');
  assert.deepEqual(step.request, streamRequest);
  // The same message the non-streaming call returns.
  assert.deepEqual(step.response, message);
  assert.equal(step.error, null);
  assert.equal(step.tokens_in, 3210);
  assert.equal(step.tokens_out, 25);
});

test('a stream cut off before message_stop is recorded with what arrived', async () => {
  reply = { status: 200, contentType: 'text/event-stream', chunks: messageStream.slice(0, 5) };
  const runId = await newRun();
  await (await messages(runId, JSON.stringify(streamRequest))).text();

  const step = await finishedStep(runId);
  assert.equal(step.error, 'upstream stream ended before message_stop');
  assert.deepEqual(step.response.content, [{ type: 'text', text: 'Listing files.' }]);
});

test('a replayed anthropic step is streamed to a streaming agent', async () => {
  // Recorded without streaming; the fork's agent streams.
  const parent = await recordParent([
    { format: 'anthropic', response: parentMessage },
    { format: 'anthropic', response: parentMessage },
  ]);
  const runId = await forkOf(parent, 1);

  const res = await messages(runId, JSON.stringify(streamRequest));
  assert.equal(res.status, 200);
  assert.deepEqual(await readStream(res), { response: parentMessage, error: null });
  assert.equal(received, undefined);
});
