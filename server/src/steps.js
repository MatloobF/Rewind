// Step recording in two calls: startStep before the live call, finishStep
// after it. All replay decisions (Phase 5) will be made in startStep, so
// the LLM proxy and the MCP proxy both just follow the mode it returns.
import { pool, withTransaction } from './db.js';
import { hashRequest } from './hash.js';
import { notFound, conflict } from './errors.js';

// Starts a step: assigns the next idx and saves the request with response NULL.
// Returns { idx, mode }. Until Phase 5 the mode is always 'live'.
export async function startStep(runId, { type, request }) {
  return withTransaction(async (client) => {
    // Lock the run row. A second startStep for the same run (e.g. LLM proxy
    // and MCP proxy at once) waits here until this transaction commits, so
    // both can't read the same MAX(idx).
    const { rows: runs } = await client.query(
      'SELECT status FROM runs WHERE id = $1 FOR UPDATE',
      [runId],
    );
    if (runs.length === 0) throw notFound(`run ${runId} not found`);
    if (runs[0].status !== 'running') {
      throw conflict(`run ${runId} is ${runs[0].status}, not running`);
    }

    const { rows } = await client.query(
      `INSERT INTO steps (run_id, idx, type, request, request_hash)
       SELECT $1, COALESCE(MAX(idx), -1) + 1, $2, $3, $4 FROM steps WHERE run_id = $1
       RETURNING idx`,
      [runId, type, JSON.stringify(request), hashRequest(request)],
    );
    return { idx: rows[0].idx, mode: 'live' };
  });
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
