import { pool } from './db.js';
import { notFound } from './errors.js';

// Creates a run in 'running' status. command is an argv array.
export async function createRun({ name = null, command, cwd }) {
  const { rows } = await pool.query(
    `INSERT INTO runs (name, command, cwd) VALUES ($1, $2, $3) RETURNING *`,
    // pg would turn a JS array into a Postgres array, not JSON, so stringify it.
    [name, JSON.stringify(command), cwd],
  );
  return rows[0];
}

// Sets a run's final status ('success' or 'failed'), e.g. when the agent exits.
export async function setRunStatus(runId, status) {
  const { rows } = await pool.query(
    `UPDATE runs SET status = $2 WHERE id = $1 RETURNING *`,
    [runId, status],
  );
  if (rows.length === 0) throw notFound(`run ${runId} not found`);
  return rows[0];
}

// Newest runs first, each with totals over its steps for the run list.
// Capped at 100 until the UI needs paging.
export async function listRuns() {
  const { rows } = await pool.query(
    `SELECT r.*,
            COUNT(s.id)::int                  AS step_count,
            COALESCE(SUM(s.tokens_in), 0)::int  AS tokens_in,
            COALESCE(SUM(s.tokens_out), 0)::int AS tokens_out,
            COALESCE(SUM(s.latency_ms), 0)::int AS latency_ms
     FROM runs r
     LEFT JOIN steps s ON s.run_id = r.id
     GROUP BY r.id
     ORDER BY r.created_at DESC
     LIMIT 100`,
  );
  return rows;
}

// One run with all its steps in idx order, for the timeline.
export async function getRun(runId) {
  const { rows } = await pool.query('SELECT * FROM runs WHERE id = $1', [runId]);
  if (rows.length === 0) throw notFound(`run ${runId} not found`);
  const { rows: steps } = await pool.query(
    'SELECT * FROM steps WHERE run_id = $1 ORDER BY idx',
    [runId],
  );
  return { ...rows[0], steps };
}

// The whole fork tree that contains runId, as a flat list of runs.
// "ancestors" walks up parent_run_id to the root; "tree" walks back down
// from that root, so asking from any run in the tree gives the same answer.
// The UI turns the flat list into nodes and edges itself.
export async function getRunTree(runId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE
       ancestors AS (
         SELECT id, parent_run_id FROM runs WHERE id = $1
         UNION ALL
         SELECT r.id, r.parent_run_id FROM runs r JOIN ancestors a ON r.id = a.parent_run_id
       ),
       tree AS (
         SELECT r.* FROM runs r
         WHERE r.id = (SELECT id FROM ancestors WHERE parent_run_id IS NULL)
         UNION ALL
         SELECT r.* FROM runs r JOIN tree t ON r.parent_run_id = t.id
       )
     SELECT id, name, status, parent_run_id, fork_step, fork_override,
            diverged_at_step, created_at
     FROM tree
     ORDER BY created_at`,
    [runId],
  );
  if (rows.length === 0) throw notFound(`run ${runId} not found`);
  return { root_id: rows[0].id, runs: rows };
}
