// Step recording in two calls: startStep before the live call, finishStep
// after it. All replay decisions are made in startStep, so the LLM proxy and
// the MCP proxy both just follow the mode it returns.
import { pool, withTransaction } from './db.js';
import { hashRequest, withTransportOf } from './hash.js';
import { notFound, conflict } from './errors.js';

// Starts a step: assigns the next idx and saves the request. `format` says
// how an llm step's JSON is shaped ('openai' unless told otherwise; tool steps
// have none). Returns
// { idx, mode } plus, depending on the mode:
//   'live'      nothing: make the real call, then finishStep
//   'replay'    { response, error } from the parent: no call, no finishStep
//   'override'  { response }: no call, no finishStep, or
//               { request }: send this edited request live, then finishStep
//
// For a fork run with fork_step = N (Rule 6):
//   idx < N  -> 'replay': the parent's recorded result
//   idx = N  -> 'override' with fork_override ('live' if there is none)
//   idx > N  -> 'live'
// If the request at idx <= N doesn't match the parent's, the run diverged:
// diverged_at_step is set, the override is skipped, and every step from then
// on is live.
export async function startStep(runId, { type, request, format = type === 'llm' ? 'openai' : null }) {
  return withTransaction(async (client) => {
    // Lock the run row. A second startStep for the same run (e.g. LLM proxy
    // and MCP proxy at once) waits here until this transaction commits, so
    // both can't read the same MAX(idx), and both see the same divergence.
    const { rows: runs } = await client.query(
      `SELECT status, parent_run_id, fork_step, fork_override, diverged_at_step
       FROM runs WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    if (runs.length === 0) throw notFound(`run ${runId} not found`);
    const run = runs[0];
    if (run.status !== 'running') {
      throw conflict(`run ${runId} is ${run.status}, not running`);
    }

    const { rows: next } = await client.query(
      'SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM steps WHERE run_id = $1',
      [runId],
    );
    const idx = next[0].idx;
    const step = { runId, idx, type, format, request, hash: hashRequest(request) };

    if (!followsParent(run, idx)) {
      await insertStep(client, step);
      return { idx, mode: 'live' };
    }

    const parentStep = await getStep(client, run.parent_run_id, idx);
    if (!matchesParent(parentStep, step)) {
      await client.query('UPDATE runs SET diverged_at_step = $2 WHERE id = $1', [runId, idx]);
      await insertStep(client, step);
      return { idx, mode: 'live' };
    }

    if (idx === run.fork_step) {
      return applyOverride(client, step, run.fork_override);
    }

    await insertStep(client, step, { ...parentStep, replayed: true });
    return { idx, mode: 'replay', response: parentStep.response, error: parentStep.error };
  });
}

// The fork step. The agent's own request has already matched the parent's.
//   'response': save the edited response as the finished result (not
//               replayed: it comes from the user, not the parent).
//   'request':  save the edited request, the one that is actually sent, so
//               the row and its hash describe the real call.
async function applyOverride(client, step, override) {
  const { idx } = step;
  if (override == null) {
    await insertStep(client, step);
    return { idx, mode: 'live' };
  }
  if (override.kind === 'response') {
    await insertStep(client, step, { response: override.response });
    return { idx, mode: 'override', response: override.response };
  }
  // Delivered as the agent asked: its stream/stream_options, not the edit's.
  const request = withTransportOf(override.request, step.request);
  const edited = { ...step, request, hash: hashRequest(request) };
  await insertStep(client, edited);
  return { idx, mode: 'override', request };
}

// True while a fork run is still on its parent's path: it has a parent,
// hasn't diverged, and hasn't gone past the fork step.
function followsParent(run, idx) {
  return run.parent_run_id != null && run.diverged_at_step == null && idx <= run.fork_step;
}

// The parent step can stand in for this one only if it exists, was finished
// (an unfinished step has nothing to replay), and asked the same thing in the
// same format (an OpenAI answer can't stand in on the Anthropic route).
function matchesParent(parentStep, step) {
  return (
    parentStep != null &&
    (parentStep.response != null || parentStep.error != null) &&
    parentStep.type === step.type &&
    parentStep.format === step.format &&
    parentStep.request_hash === step.hash
  );
}

async function getStep(client, runId, idx) {
  const { rows } = await client.query(
    'SELECT * FROM steps WHERE run_id = $1 AND idx = $2',
    [runId, idx],
  );
  return rows[0] ?? null;
}

// Inserts a step. Without `result` it's a live step with response NULL, to be
// finished later. With it, the row is complete already (a replayed or
// overridden result). latency_ms stays NULL then, because no call was made.
async function insertStep(client, { runId, idx, type, format, request, hash }, result = {}) {
  const { response = null, error = null, tokens_in = null, tokens_out = null, replayed = false } = result;
  await client.query(
    `INSERT INTO steps
       (run_id, idx, type, format, request, request_hash, response, error, tokens_in, tokens_out, replayed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      runId,
      idx,
      type,
      format,
      JSON.stringify(request),
      hash,
      // pg parsed the parent's JSONB into an object; stringify it back. NULL stays NULL.
      response == null ? null : JSON.stringify(response),
      error,
      tokens_in,
      tokens_out,
      replayed,
    ],
  );
}

// Finishes a live step with the result of the real call. A step can be
// finished once; a second finish (or finishing a replayed step) is a conflict.
export async function finishStep(runId, idx, result) {
  const { response, error = null, latency_ms = null, tokens_in = null, tokens_out = null } = result;
  const { rows } = await pool.query(
    `UPDATE steps
     SET response = $3, error = $4, latency_ms = $5, tokens_in = $6, tokens_out = $7
     WHERE run_id = $1 AND idx = $2 AND response IS NULL AND error IS NULL
     RETURNING *`,
    [
      runId,
      idx,
      // undefined/null must become SQL NULL; JSON.stringify(null) would store JSON null.
      response == null ? null : JSON.stringify(response),
      error,
      latency_ms,
      tokens_in,
      tokens_out,
    ],
  );
  if (rows.length > 0) return rows[0];

  // Nothing updated: tell "no such step" apart from "already finished".
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM steps WHERE run_id = $1 AND idx = $2',
    [runId, idx],
  );
  if (existing.length === 0) throw notFound(`step ${idx} of run ${runId} not found`);
  throw conflict(`step ${idx} of run ${runId} is already finished`);
}
