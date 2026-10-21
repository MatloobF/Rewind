// Small fetch helpers for the Rewind API. Paths are relative because Vite
// proxies /api to the server in dev. The demo build reads saved files instead.
import { demoDataUrl, isDemo } from './demo.js';

async function getJson(path) {
  const res = await fetch(isDemo ? demoDataUrl(path) : path);
  const body = await res.json().catch(() => null);
  // The API answers errors with { error: message }; FastAPI (intel) with { detail }.
  if (!res.ok) throw new Error(body?.error ?? body?.detail ?? `HTTP ${res.status}`);
  return body;
}

export const fetchRuns = () => getJson('/api/runs');
export const fetchRun = (id) => getJson(`/api/runs/${id}`);
export const fetchRunTree = (id) => getJson(`/api/runs/${id}/tree`);

// The Python intel service, proxied by Vite at /intel.
export const fetchFailurePatterns = () => getJson('/intel/failures/clusters');
export const fetchRunLoops = (id) => getJson(`/intel/runs/${id}/loops`);

async function postJson(path, body) {
  if (isDemo) throw new Error('this is a read-only demo');
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// Body: { fork_step, fork_override?, name?, setup? } -> the new fork run.
export const forkRun = (id, body) => postJson(`/api/runs/${id}/fork`, body);

export const fetchEvals = () => getJson('/api/evals');
export const fetchEval = (id) => getJson(`/api/evals/${id}`);
// Proposed assertions for a finished run, from the intel service. Not saved.
export const fetchEvalDraft = (runId) => getJson(`/intel/runs/${runId}/eval-draft`);
// Body: { source_run_id, input_task, assertions, setup? } -> the new eval.
export const createEval = (body) => postJson('/api/evals', body);
// Starts a live run of the eval -> { run, result } (result.passed is null until it's checked).
export const runEval = (id) => postJson(`/api/evals/${id}/runs`);
