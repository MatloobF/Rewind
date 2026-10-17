import os
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgres://postgres:rewind@localhost:5432/rewind"
)


def connect() -> psycopg.Connection:
    """Open a read-only connection.

    The intel service must never write (Rule 3: writes go through the Node API).
    default_transaction_read_only makes Postgres itself reject INSERT/UPDATE/DELETE,
    so the rule holds even if a query here is written wrong.
    """
    return psycopg.connect(
        DATABASE_URL,
        options="-c default_transaction_read_only=on",
        row_factory=dict_row,
    )


def get_failure_candidates(limit: int = 500) -> list[tuple[dict, list[dict]]]:
    """Recent finished runs that failed or have a live (non-replayed) step error,
    each with its steps. Only the small columns are read: LLM requests carry the
    whole conversation and aren't needed here.
    """
    with connect() as conn:
        runs = conn.execute(
            "SELECT id, name, status FROM runs r"
            " WHERE r.status = 'failed' OR (r.status <> 'running' AND EXISTS ("
            "   SELECT 1 FROM steps s"
            "   WHERE s.run_id = r.id AND s.error IS NOT NULL AND NOT s.replayed))"
            " ORDER BY r.created_at DESC LIMIT %s",
            (limit,),
        ).fetchall()
        steps = conn.execute(
            "SELECT run_id, idx, type, request->>'name' AS tool, error,"
            " response IS NULL AS no_response, replayed"
            " FROM steps WHERE run_id = ANY(%s) ORDER BY run_id, idx",
            ([r["id"] for r in runs],),
        ).fetchall()
    by_run: dict = {r["id"]: [] for r in runs}
    for s in steps:
        by_run[s["run_id"]].append(s)
    return [(r, by_run[r["id"]]) for r in runs]


def get_run_steps(run_id: UUID) -> list[dict] | None:
    """A run's steps in idx order, or None if the run doesn't exist."""
    with connect() as conn:
        if conn.execute("SELECT 1 FROM runs WHERE id = %s", (run_id,)).fetchone() is None:
            return None
        return conn.execute(
            "SELECT idx, type, request, request_hash, error"
            " FROM steps WHERE run_id = %s ORDER BY idx",
            (run_id,),
        ).fetchall()
