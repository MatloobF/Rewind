// LLM recording proxy, in two API formats:
//   POST /r/:runId/v1/chat/completions   OpenAI format (Ollama, OpenAI, ...)
//   POST /r/:runId/v1/messages           Anthropic format (Anthropic, Ollama)
// Both work the same way. What differs (the upstream, the path, where the
// token counts are, how a stream is read and replayed) is in FORMATS below.
// The step's `format` records which one.
// An agent is recorded by pointing its base URL at /r/:runId. The proxy
// forwards the request bytes unchanged to the real LLM and sends back the
// upstream status and body unchanged, recording both as one 'llm' step.
// A streamed answer (stream: true) is forwarded chunk by chunk as it arrives
// and recorded in the same shape as a non-streamed one (see sse.js).
// In a fork run, startStep may instead say to replay the parent's answer or
// apply the fork override (Rule 6); the proxy just follows that mode.
import express, { Router } from 'express';
import { badRequest } from './errors.js';
import { startStep, finishStep } from './steps.js';
import {
  createSseParser, createChatAssembler, chatChunks, createMessageAssembler, messageEvents,
} from './sse.js';
import { isUuid, isPlainObject } from './validate.js';

// Headers passed through to the upstream. Others (host, content-length,
// the SDK's x-stainless-* telemetry) are either set by fetch or irrelevant.
// The key headers are forwarded but never recorded: only bodies are stored.
const FORWARDED_HEADERS = [
  'content-type', 'accept', 'authorization',
  'x-api-key', 'anthropic-version', 'anthropic-beta', // Anthropic format
];

// What differs between the formats: the upstream path, the token counts, the
// assembler that rebuilds a streamed answer, and the replay stream.
const FORMATS = {
  openai: {
    path: '/v1/chat/completions',
    tokensOf: openaiTokens,
    createAssembler: createChatAssembler,
    // usage only if the agent asked for it, as upstream would.
    toStream: (response, request) =>
      chatChunks(response, { includeUsage: request.stream_options?.include_usage === true }),
  },
  anthropic: {
    path: '/v1/messages',
    tokensOf: anthropicTokens,
    createAssembler: createMessageAssembler,
    toStream: (response) => messageEvents(response),
  },
};

// upstreamUrl serves the OpenAI format. anthropicUpstreamUrl serves the
// Anthropic one; by default the same server, since Ollama speaks both.
export function createProxy({ upstreamUrl, anthropicUpstreamUrl = upstreamUrl }) {
  const upstreams = {
    openai: upstreamUrl.replace(/\/+$/, ''),
    anthropic: anthropicUpstreamUrl.replace(/\/+$/, ''),
  };
  const proxy = Router();

  // Raw bytes, not express.json(): we forward exactly what the agent sent,
  // and parse a copy only for recording.
  proxy.use(express.raw({ type: () => true, limit: '10mb' }));

  proxy.post('/:runId/v1/chat/completions', (req, res) => handleCall(req, res, 'openai', upstreams.openai));
  proxy.post('/:runId/v1/messages', (req, res) => handleCall(req, res, 'anthropic', upstreams.anthropic));

  return proxy;
}

// One LLM call, recorded as one 'llm' step in the given format.
async function handleCall(req, res, format, upstream) {
  const api = FORMATS[format];
  const { runId } = req.params;
  if (!isUuid(runId)) throw badRequest('run id must be a UUID');

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const request = parseJson(rawBody.toString('utf8'));
  if (!isPlainObject(request)) {
    throw badRequest('request body must be a JSON object');
  }
  const step = await startStep(runId, { type: 'llm', format, request });
  const { idx } = step;

  // No upstream call: the step is already finished in the database.
  if (step.mode === 'replay') return sendRecorded(res, api, request, step.response, step.error);
  if (step.mode === 'override' && step.response) return sendResponse(res, api, request, step.response);

  // Live call: the agent's exact bytes, or the edited request at a fork step.
  const body = step.mode === 'override' ? JSON.stringify(step.request) : rawBody;
  const started = Date.now();
  let upstreamRes;
  try {
    upstreamRes = await fetch(`${upstream}${api.path}`, {
      method: 'POST',
      headers: pickHeaders(req.headers),
      body,
    });
  } catch (err) {
    // Upstream unreachable: record the failure, tell the agent with a 502.
    const error = `upstream request failed: ${err.cause?.code ?? err.message}`;
    await finishStep(runId, idx, { error, latency_ms: Date.now() - started });
    return res.status(502).json({ error });
  }
  // A streamed answer. An error status comes back as plain JSON even for a
  // streaming request, so it takes the buffered path below.
  if (upstreamRes.ok && isEventStream(upstreamRes)) {
    return relayStream(res, upstreamRes, { api, runId, idx, started });
  }

  const bodyBuffer = Buffer.from(await upstreamRes.arrayBuffer());
  const latency_ms = Date.now() - started;

  const response = parseJson(bodyBuffer.toString('utf8'));
  await finishStep(runId, idx, {
    response: response ?? null,
    error: describeError(upstreamRes.status, response),
    latency_ms,
    ...api.tokensOf(response),
  });

  // Send the upstream answer back unchanged.
  const contentType = upstreamRes.headers.get('content-type');
  if (contentType) res.type(contentType);
  res.status(upstreamRes.status).send(bodyBuffer);
}

// Forwards a streamed answer to the agent chunk by chunk, as it arrives, with
// the bytes unchanged (Rule 2). A copy of each chunk goes to the parser, and
// the rebuilt response is recorded once the stream ends.
async function relayStream(res, upstreamRes, { api, runId, idx, started }) {
  res.status(upstreamRes.status);
  res.type(upstreamRes.headers.get('content-type'));
  res.flushHeaders(); // The agent's SDK starts reading now, not at the end.

  const parser = createSseParser();
  const assembler = api.createAssembler();
  const addEvents = (events) => events.forEach((event) => assembler.add(event.data));
  // 'close' before we end the response means the agent hung up.
  let agentGone = false;
  res.on('close', () => { agentGone = true; });
  let failure = null;
  try {
    for await (const chunk of upstreamRes.body) {
      // Leaving the loop cancels the upstream body, which closes that
      // connection too: nobody is left to read the rest.
      if (agentGone) {
        failure = 'agent disconnected mid-stream';
        break;
      }
      res.write(chunk);
      addEvents(parser.push(chunk));
    }
    addEvents(parser.end());
  } catch (err) {
    failure = `upstream stream failed: ${err.cause?.code ?? err.message}`;
  }

  const { response, error } = assembler.result();
  await finishStep(runId, idx, {
    response,
    error: failure ?? error,
    latency_ms: Date.now() - started,
    ...api.tokensOf(response),
  });

  // An upstream that broke off is passed on as a broken-off stream, so the
  // agent sees the same failure it would without the proxy.
  if (failure) res.destroy();
  else res.end();
}

function isEventStream(upstreamRes) {
  return /^text\/event-stream\b/i.test(upstreamRes.headers.get('content-type') ?? '');
}

// Token counts from an OpenAI-format usage block, if there is one.
function openaiTokens(response) {
  return {
    tokens_in: response?.usage?.prompt_tokens ?? null,
    tokens_out: response?.usage?.completion_tokens ?? null,
  };
}

// Anthropic splits the prompt into new, cache-written and cache-read tokens.
// tokens_in is their sum, so it means "prompt size" as prompt_tokens does:
// with prompt caching, input_tokens alone can be a handful for a huge prompt.
function anthropicTokens(response) {
  const usage = response?.usage;
  if (usage?.input_tokens == null) return { tokens_in: null, tokens_out: usage?.output_tokens ?? null };
  const tokens_in =
    usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return { tokens_in, tokens_out: usage.output_tokens ?? null };
}

// Returns the parsed value, or undefined if the text is not valid JSON.
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function pickHeaders(headers) {
  const picked = {};
  for (const name of FORWARDED_HEADERS) {
    if (headers[name]) picked[name] = headers[name];
  }
  return picked;
}

// Sends a replayed step back as the parent's agent got it, as far as the row
// allows. The status isn't stored, but describeError wrote it into the error
// text. A failure with no recorded body (unreachable upstream, non-JSON body)
// is sent as 502 { error }, like an unreachable upstream in record mode.
// Errors stay JSON even for a streaming agent: upstream answers them that way.
function sendRecorded(res, api, request, response, error) {
  if (error == null) return sendResponse(res, api, request, response);
  const status = Number(error.match(/^upstream HTTP (\d{3})/)?.[1]);
  if (status && response != null) return res.status(status).json(response);
  return res.status(502).json({ error });
}

// Sends a stored response the way this agent asked for it: as an SSE stream
// if its request said stream: true (whether or not the parent streamed: the
// hash ignores `stream`), else as JSON.
function sendResponse(res, api, request, response) {
  if (!request.stream) return res.status(200).json(response);
  res.status(200).type('text/event-stream; charset=utf-8').send(api.toStream(response, request));
}

// The error column for an upstream answer, or null if it was a normal reply.
function describeError(status, response) {
  if (status >= 400) {
    const message = response?.error?.message ?? response?.error ?? '';
    return `upstream HTTP ${status}${message ? `: ${typeof message === 'string' ? message : JSON.stringify(message)}` : ''}`;
  }
  if (response === undefined) return 'upstream returned a non-JSON body';
  return null;
}
