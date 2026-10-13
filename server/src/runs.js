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
