import { pool } from './db.js';
import { badRequest, notFound, conflict } from './errors.js';
import { forkOverrideError } from './validate.js';

// Creates a run in 'running' status. command is an argv array.
// A fork also passes parentRunId and forkStep, and usually a forkOverride;
// startStep then replays the parent before forkStep and applies the override
// at it. A fork with no override just replays and then goes live.
export async function createRun({
  name = null,
  command,
  cwd,
  parentRunId = null,
  forkStep = null,
  forkOverride = null,
}) {
  checkForkFields({ parentRunId, forkStep, forkOverride });
  const { rows } = await pool.query(
    `INSERT INTO runs (name, command, cwd, parent_run_id, fork_step, fork_override)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    // pg would turn a JS array into a Postgres array, not JSON, so stringify it.
    [
      name,
      JSON.stringify(command),
      cwd,
      parentRunId,
      forkStep,
      forkOverride == null ? null : JSON.stringify(forkOverride),
    ],
  );
  return rows[0];
}

// Creates a fork of a finished run at one of its steps. The fork gets the
// parent's command and cwd, so it re-launches the same agent and task.
export async function createFork(parentId, { forkStep, forkOverride = null, name = null }) {
  const { rows } = await pool.query(
    `SELECT r.name, r.command, r.cwd, r.status, MAX(s.idx) AS last_idx
     FROM runs r LEFT JOIN steps s ON s.run_id = r.id
     WHERE r.id = $1
     GROUP BY r.id`,
    [parentId],
  );
  if (rows.length === 0) throw notFound(`run ${parentId} not found`);
  const parent = rows[0];
  // A running run's steps aren't final yet, so there is nothing stable to replay.
  if (parent.status === 'running') {
    throw conflict(`run ${parentId} is still running; fork it once it has finished`);
  }
  if (parent.last_idx == null) throw badRequest(`run ${parentId} has no steps to fork at`);
  if (!Number.isInteger(forkStep) || forkStep < 0 || forkStep > parent.last_idx) {
    throw badRequest(`fork_step must be a step of run ${parentId} (0 to ${parent.last_idx})`);
  }

  return createRun({
    name: name ?? `${parent.name ?? 'run'} (fork at step ${forkStep})`,
    command: parent.command,
    cwd: parent.cwd,
    parentRunId: parentId,
    forkStep,
    forkOverride,
  });
}

// The fork fields come together: a parent needs a fork step, and a fork step
// or override without a parent means nothing.
function checkForkFields({ parentRunId, forkStep, forkOverride }) {
  if (parentRunId == null) {
    if (forkStep != null || forkOverride != null) {
      throw badRequest('fork_step and fork_override need a parent run');
    }
    return;
  }
  if (!Number.isInteger(forkStep) || forkStep < 0) {
    throw badRequest('fork_step must be a non-negative integer');
  }
  if (forkOverride != null) {
    const message = forkOverrideError(forkOverride);
    if (message) throw badRequest(message);
  }
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
