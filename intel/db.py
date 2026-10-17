import os

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
