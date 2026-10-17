import { pool, withTransaction } from './db.js';
import { notFound, conflict } from './errors.js';
import { getRun } from './runs.js';
import { checkAssertions } from './assertions.js';

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

// Starts one run of an eval: a new live run (no parent, nothing replayed)
// with the eval's command and cwd, plus its result row with passed NULL.
// Both are created together, so a result never points at a missing run and
// a run started for an eval always has its result row.
// Returns { evalRow, run, result }; the caller launches the agent.
export async function startEvalRun(evalId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM evals WHERE id = $1', [evalId]);
    if (rows.length === 0) throw notFound(`eval ${evalId} not found`);
    const evalRow = rows[0];

    const { rows: runs } = await client.query(
      `INSERT INTO runs (name, command, cwd) VALUES ($1, $2, $3) RETURNING *`,
      [`[eval] ${evalRow.input_task}`, JSON.stringify(evalRow.command), evalRow.cwd],
    );
    const run = runs[0];
    const { rows: results } = await client.query(
      `INSERT INTO eval_results (eval_id, run_id) VALUES ($1, $2) RETURNING *`,
      [evalId, run.id],
    );
    return { evalRow, run, result: results[0] };
  });
}

// Checks a finished eval run against its eval's assertions and saves the
// verdict on its result row. Returns the updated row.
export async function checkEvalResult(resultId) {
  const { rows } = await pool.query(
    `SELECT er.run_id, e.assertions
     FROM eval_results er JOIN evals e ON e.id = er.eval_id
     WHERE er.id = $1`,
    [resultId],
  );
  if (rows.length === 0) throw notFound(`eval result ${resultId} not found`);
  const { run_id, assertions } = rows[0];

  const run = await getRun(run_id);
  const { passed, failures } = checkAssertions(run, run.steps, assertions);
  const { rows: updated } = await pool.query(
    `UPDATE eval_results SET passed = $2, failures = $3 WHERE id = $1 RETURNING *`,
    [resultId, passed, JSON.stringify(failures)],
  );
  return updated[0];
}
