import uuid

import pytest
from fastapi.testclient import TestClient

from db import connect
from main import app

client = TestClient(app)


def test_unknown_run_is_404():
    res = client.get(f"/runs/{uuid.uuid4()}/loops")
    assert res.status_code == 404


def test_malformed_run_id_is_422():
    res = client.get("/runs/not-a-uuid/loops")
    assert res.status_code == 422


def test_recorded_run_returns_a_loop_list():
    # Read-only service: use whatever run the dev database already has.
    with connect() as conn:
        row = conn.execute("SELECT id FROM runs LIMIT 1").fetchone()
    if row is None:
        pytest.skip("no recorded runs in the database")
    res = client.get(f"/runs/{row['id']}/loops")
    assert res.status_code == 200
    assert res.json()["run_id"] == str(row["id"])
    assert isinstance(res.json()["loops"], list)
