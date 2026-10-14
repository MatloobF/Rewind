// LLM recording proxy: POST /r/:runId/v1/chat/completions.
// An agent is recorded by pointing its base URL at /r/:runId/v1. The proxy
// forwards the request bytes unchanged to the real LLM and sends back the
// upstream status and body unchanged, recording both as one 'llm' step.
// In a fork run, startStep may instead say to replay the parent's answer or
// apply the fork override (Rule 6); the proxy just follows that mode.
import express, { Router } from 'express';
import { badRequest } from './errors.js';
import { startStep, finishStep } from './steps.js';
import { isUuid, isPlainObject } from './validate.js';

// Headers passed through to the upstream. Others (host, content-length,
// the SDK's x-stainless-* telemetry) are either set by fetch or irrelevant.
const FORWARDED_HEADERS = ['content-type', 'accept', 'authorization'];

export function createProxy({ upstreamUrl }) {
  const upstream = upstreamUrl.replace(/\/+$/, '');
  const proxy = Router();

  // Raw bytes, not express.json(): we forward exactly what the agent sent,
  // and parse a copy only for recording.
  proxy.use(express.raw({ type: () => true, limit: '10mb' }));

  proxy.post('/:runId/v1/chat/completions', async (req, res) => {
    const { runId } = req.params;
    if (!isUuid(runId)) throw badRequest('run id must be a UUID');

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const request = parseJson(rawBody.toString('utf8'));
    if (!isPlainObject(request)) {
      throw badRequest('request body must be a JSON object');
    }
    if (request.stream) throw badRequest('streaming is not supported yet (planned for Phase 9)');

    const step = await startStep(runId, { type: 'llm', request });
    const { idx } = step;

    // No upstream call: the step is already finished in the database.
    if (step.mode === 'replay') return sendRecorded(res, step.response, step.error);
    if (step.mode === 'override' && step.response) return res.status(200).json(step.response);

    // Live call: the agent's exact bytes, or the edited request at a fork step.
    const body = step.mode === 'override' ? JSON.stringify(step.request) : rawBody;
    const started = Date.now();
    let upstreamRes;
    try {
      upstreamRes = await fetch(`${upstream}/v1/chat/completions`, {
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
    const bodyBuffer = Buffer.from(await upstreamRes.arrayBuffer());
    const latency_ms = Date.now() - started;

    const response = parseJson(bodyBuffer.toString('utf8'));
    await finishStep(runId, idx, {
      response: response ?? null,
      error: describeError(upstreamRes.status, response),
      latency_ms,
      tokens_in: response?.usage?.prompt_tokens ?? null,
      tokens_out: response?.usage?.completion_tokens ?? null,
    });

    // Send the upstream answer back unchanged.
    const contentType = upstreamRes.headers.get('content-type');
    if (contentType) res.type(contentType);
    res.status(upstreamRes.status).send(bodyBuffer);
  });

  return proxy;
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
function sendRecorded(res, response, error) {
  if (error == null) return res.status(200).json(response);
  const status = Number(error.match(/^upstream HTTP (\d{3})/)?.[1]);
  if (status && response != null) return res.status(status).json(response);
  return res.status(502).json({ error });
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
