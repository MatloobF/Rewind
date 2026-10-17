// `rewind eval <eval-id>... | --all`
//
// Runs evals one at a time and waits for each verdict. The server launches
// each eval's agent (like a fork) and checks its assertions when the agent
// exits, so the agent's output appears in the server's terminal, and the
// CLI only starts runs and reads results. One at a time because evals of
// the same agent share its files (the sample agent's sandbox).
//
// Exits 0 only if every eval passed, so it can gate a commit or a CI job.
// Ctrl+C stops the waiting; a run already started still finishes and is
// checked on the server.
import { callApi, log } from './apiClient.js';
import { isUuid } from './validate.js';

export const EVAL_USAGE = 'usage: rewind eval <eval-id>... | --all';

const POLL_MS = 2000;
// A server restart leaves a result unchecked forever, so stop waiting at
// some point. A sample agent run takes about 3 minutes on CPU.
const TIMEOUT_MS = 30 * 60 * 1000;

const short = (id) => id.slice(0, 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Either { all: true } or { ids: [...] }, never both.
export function parseEvalArgs(args) {
  if (args.length === 0) throw new Error(`missing eval id or --all\n${EVAL_USAGE}`);
  if (args.includes('--all')) {
    if (args.length > 1) throw new Error(`--all takes no eval ids\n${EVAL_USAGE}`);
    return { all: true, ids: [] };
  }
  const bad = args.find((a) => !isUuid(a));
  if (bad) throw new Error(`"${bad}" is not an eval id (a UUID)\n${EVAL_USAGE}`);
  return { all: false, ids: args };
}

// Resolves with the CLI exit code: 0 if every eval passed, 1 otherwise.
export async function runEvalCommand({ ids, all, serverUrl, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS }) {
  let evalIds = ids;
  if (all) {
    try {
      const evals = await callApi(serverUrl, 'GET', '/api/evals');
      evalIds = evals.reverse().map((e) => e.id); // the list is newest first; run oldest first
    } catch (err) {
      log(`could not list evals: ${err.cause?.code ?? err.message}`);
      log(`is the Rewind server running at ${serverUrl}? (cd server && npm run dev)`);
      return 1;
    }
    if (evalIds.length === 0) {
      log('no evals saved yet');
      return 0;
    }
  }
  return runEvals(evalIds, { serverUrl, pollMs, timeoutMs });
}

// Runs each eval in turn and prints its verdict. Exported for tests, which
// pass their own ids instead of --all (that would run every saved eval).
export async function runEvals(evalIds, { serverUrl, pollMs = POLL_MS, timeoutMs = TIMEOUT_MS }) {
  let passed = 0;
  for (const evalId of evalIds) {
    if (await runOne(evalId, { serverUrl, pollMs, timeoutMs })) passed++;
  }
  log(`${passed} of ${evalIds.length} evals passed`);
  return passed === evalIds.length ? 0 : 1;
}

// Starts one eval run and waits for its result. Returns true if it passed.
async function runOne(evalId, { serverUrl, pollMs, timeoutMs }) {
  let started;
  try {
    started = await callApi(serverUrl, 'POST', `/api/evals/${evalId}/runs`);
  } catch (err) {
    log(`ERROR ${short(evalId)}: could not start: ${err.cause?.code ?? err.message}`);
    return false;
  }
  const { run, result } = started;
  log(`eval ${short(evalId)} "${run.name.replace(/^\[eval\] /, '')}": run ${run.id} started`);

  const checked = await waitForResult(evalId, result.id, { serverUrl, pollMs, timeoutMs });
  if (checked == null) {
    log(`ERROR ${short(evalId)}: no verdict after ${Math.round(timeoutMs / 60000)} min (run ${run.id})`);
    return false;
  }
  log(`${checked.passed ? 'PASS' : 'FAIL'}  ${short(evalId)}  (run ${short(run.id)})`);
  for (const failure of checked.failures ?? []) log(`        - ${failure.message}`);
  return checked.passed;
}

// Polls the eval until this result has a verdict. Returns the result row,
// or null on timeout. A failed poll (e.g. the server restarting) is retried.
async function waitForResult(evalId, resultId, { serverUrl, pollMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const ev = await callApi(serverUrl, 'GET', `/api/evals/${evalId}`);
      const result = ev.results.find((r) => r.id === resultId);
      if (result && result.passed !== null) return result;
    } catch {
      // keep waiting until the deadline
    }
  }
  return null;
}
