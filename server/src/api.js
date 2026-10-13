// REST routes under /api. Each handler validates its input, then calls the
// store functions in runs.js / steps.js.
import { Router } from 'express';
import { badRequest } from './errors.js';
import { createRun, setRunStatus } from './runs.js';
import { startStep, finishStep } from './steps.js';
import { isUuid, isPlainObject } from './validate.js';

const FINAL_STATUSES = ['success', 'failed'];
const STEP_TYPES = ['llm', 'tool'];

const isCount = (v) => v == null || (Number.isInteger(v) && v >= 0);

function runIdParam(req) {
  if (!isUuid(req.params.id)) throw badRequest('run id must be a UUID');
  return req.params.id;
}

export const api = Router();

// Create a run (used by the CLI). Body: { name?, command: string[], cwd }
api.post('/runs', async (req, res) => {
  const { name, command, cwd } = req.body ?? {};
  if (name != null && typeof name !== 'string') throw badRequest('name must be a string');
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string')) {
    throw badRequest('command must be a non-empty array of strings');
  }
  if (typeof cwd !== 'string' || cwd === '') throw badRequest('cwd must be a non-empty string');
  res.status(201).json(await createRun({ name, command, cwd }));
});

// Set the final status when the agent exits. Body: { status: 'success' | 'failed' }
api.patch('/runs/:id', async (req, res) => {
  const runId = runIdParam(req);
  const { status } = req.body ?? {};
  if (!FINAL_STATUSES.includes(status)) throw badRequest(`status must be one of ${FINAL_STATUSES.join(', ')}`);
  res.json(await setRunStatus(runId, status));
});

// Start a step. Body: { type: 'llm' | 'tool', request: object } -> { idx, mode }
api.post('/runs/:id/steps', async (req, res) => {
  const runId = runIdParam(req);
  const { type, request } = req.body ?? {};
  if (!STEP_TYPES.includes(type)) throw badRequest(`type must be one of ${STEP_TYPES.join(', ')}`);
  if (!isPlainObject(request)) throw badRequest('request must be an object');
  res.status(201).json(await startStep(runId, { type, request }));
});

// Finish a live step. Body: { response, error, latency_ms, tokens_in, tokens_out }
api.patch('/runs/:id/steps/:idx', async (req, res) => {
  const runId = runIdParam(req);
  if (!/^\d+$/.test(req.params.idx)) throw badRequest('idx must be a non-negative integer');
  const idx = Number(req.params.idx);

  const body = req.body ?? {};
  const { response, error } = body;
  if (error != null && typeof error !== 'string') throw badRequest('error must be a string');
  if (response == null && error == null) throw badRequest('response or error is required');
  for (const field of ['latency_ms', 'tokens_in', 'tokens_out']) {
    if (!isCount(body[field])) throw badRequest(`${field} must be a non-negative integer`);
  }
  res.json(await finishStep(runId, idx, body));
});
