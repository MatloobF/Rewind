// REST routes under /api. Each handler validates its input, then calls the
// store functions in runs.js / steps.js.
import { Router } from 'express';
import { badRequest } from './errors.js';
import { createRun, createFork, setRunStatus, listRuns, getRun, getRunTree } from './runs.js';
import { launchRun } from './launcher.js';
import { startStep, finishStep } from './steps.js';
import { createEval, listEvals, getEval } from './evals.js';
import { assertionsError } from './assertions.js';
import { isUuid, isPlainObject, isArgv } from './validate.js';

const FINAL_STATUSES = ['success', 'failed'];
const STEP_TYPES = ['llm', 'tool'];

const isCount = (v) => v == null || (Number.isInteger(v) && v >= 0);

function runIdParam(req) {
  if (!isUuid(req.params.id)) throw badRequest('run id must be a UUID');
  return req.params.id;
}

export const api = Router();

// Run list, newest first, with step and token totals.
api.get('/runs', async (req, res) => {
  res.json(await listRuns());
});

// One run with all its steps (full request and response JSON).
api.get('/runs/:id', async (req, res) => {
  res.json(await getRun(runIdParam(req)));
});

// The fork tree containing this run: { root_id, runs: [...] }.
api.get('/runs/:id/tree', async (req, res) => {
  res.json(await getRunTree(runIdParam(req)));
});

// Create a run (used by the CLI). Body: { name?, command: string[], cwd }
api.post('/runs', async (req, res) => {
  const { name, command, cwd } = req.body ?? {};
  if (name != null && typeof name !== 'string') throw badRequest('name must be a string');
  if (!isArgv(command)) throw badRequest('command must be a non-empty array of strings');
  if (typeof cwd !== 'string' || cwd === '') throw badRequest('cwd must be a non-empty string');
  res.status(201).json(await createRun({ name, command, cwd }));
});

// Fork a finished run at one of its steps and launch its agent again.
// Body: { fork_step, fork_override?, name?, setup?: string[] } -> the new run.
// Answers as soon as the run exists; the agent runs in the background and
// the run's status is set when it exits.
api.post('/runs/:id/fork', async (req, res) => {
  const parentId = runIdParam(req);
  const { fork_step, fork_override = null, name = null, setup = null } = req.body ?? {};
  if (name != null && typeof name !== 'string') throw badRequest('name must be a string');
  if (setup != null && !isArgv(setup)) throw badRequest('setup must be a non-empty array of strings');

  const run = await createFork(parentId, { forkStep: fork_step, forkOverride: fork_override, name });
  res.status(201).json(run);
  launchRun(run, { serverUrl: req.app.locals.serverUrl, setup });
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

// Evals, newest first, each with its latest result and pass counts.
api.get('/evals', async (req, res) => {
  res.json(await listEvals());
});

// One eval with all its results, newest first.
api.get('/evals/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw badRequest('eval id must be a UUID');
  res.json(await getEval(req.params.id));
});

// Save an eval made from a finished run.
// Body: { source_run_id, input_task, assertions: [...], setup?: string[] }
// There is no route for writing results: only the server writes them, when
// an eval run it launched exits.
api.post('/evals', async (req, res) => {
  const { source_run_id, input_task, assertions, setup = null } = req.body ?? {};
  if (!isUuid(source_run_id)) throw badRequest('source_run_id must be a UUID');
  if (typeof input_task !== 'string' || input_task.trim() === '') {
    throw badRequest('input_task must be a non-empty string');
  }
  const message = assertionsError(assertions);
  if (message) throw badRequest(message);
  if (setup != null && !isArgv(setup)) throw badRequest('setup must be a non-empty array of strings');

  res.status(201).json(await createEval({ sourceRunId: source_run_id, inputTask: input_task, assertions, setup }));
});
