import psycopg
import pytest
from fastapi.testclient import TestClient

from db import connect
from main import app

client = TestClient(app)


def test_health_reaches_postgres():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_connection_rejects_writes():
    with connect() as conn:
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            # WHERE false: even if the guard broke, no row would change.
            conn.execute("UPDATE runs SET name = name WHERE false")
