import { pool } from './db.js';
import { notFound, conflict } from './errors.js';

// Creates an eval from a finished run. Like a fork, it copies the run's
// command and cwd, so the eval re-launches the same agent and task, and
// keeps working if the source run is deleted later.
export async function createEval({ sourceRunId, inputTask, assertions, setup = null }) {
  const { rows } = await pool.query('SELECT command, cwd, status FROM runs WHERE id = $1', [sourceRunId]);
  if (rows.length === 0) throw notFound(`run ${sourceRunId} not found`);
  const source = rows[0];
  if (source.status === 'running') {
    throw conflict(`run ${sourceRunId} is still running; make an eval from it once it has finished`);
  }

  const { rows: created } = await pool.query(
    `INSERT INTO evals (source_run_id, input_task, command, cwd, setup, assertions)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    // pg would turn JS arrays into Postgres arrays, not JSON, so stringify them.
    [
      sourceRunId,
      inputTask,
      JSON.stringify(source.command),
      source.cwd,
      setup == null ? null : JSON.stringify(setup),
      JSON.stringify(assertions),
    ],
  );
  return created[0];
}

// Newest evals first, each with its latest result (or null) and how many of
// its checked results passed. Results still running (passed NULL) count in
// result_count but not in checked_count.
export async function listEvals() {
  const { rows } = await pool.query(
    `SELECT e.*,
            counts.result_count, counts.checked_count, counts.passed_count,
            to_jsonb(latest) AS latest_result
     FROM evals e
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int                               AS result_count,
              COUNT(passed)::int                          AS checked_count,
              COUNT(*) FILTER (WHERE passed)::int         AS passed_count
       FROM eval_results WHERE eval_id = e.id
     ) counts
     LEFT JOIN LATERAL (
       SELECT id, run_id, passed, failures, created_at
       FROM eval_results WHERE eval_id = e.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest ON true
     ORDER BY e.created_at DESC
     LIMIT 100`,
  );
  return rows;
}

// One eval with all its results, newest first, each with its run's status.
export async function getEval(evalId) {
  const { rows } = await pool.query('SELECT * FROM evals WHERE id = $1', [evalId]);
  if (rows.length === 0) throw notFound(`eval ${evalId} not found`);
  const { rows: results } = await pool.query(
    `SELECT er.*, r.status AS run_status
     FROM eval_results er JOIN runs r ON r.id = er.run_id
     WHERE er.eval_id = $1
     ORDER BY er.created_at DESC, er.id DESC`,
    [evalId],
  );
  return { ...rows[0], results };
}
