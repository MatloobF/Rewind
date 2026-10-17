import uuid

import pytest
from fastapi.testclient import TestClient

import main
from db import connect

client = TestClient(main.app)


def test_unknown_run_is_404():
    assert client.get(f"/runs/{uuid.uuid4()}/eval-draft").status_code == 404


def test_malformed_run_id_is_422():
    assert client.get("/runs/not-a-uuid/eval-draft").status_code == 422


def test_running_run_is_409(monkeypatch):
    # The service is read-only and can't create a running run, so fake the lookup.
    run_id = uuid.uuid4()
    monkeypatch.setattr(main, "get_run", lambda _: {"id": run_id, "name": "r", "status": "running", "command": []})
    assert client.get(f"/runs/{run_id}/eval-draft").status_code == 409


def test_finished_run_returns_a_draft():
    # Read-only service: use whatever finished run the dev database already has.
    with connect() as conn:
        row = conn.execute("SELECT id FROM runs WHERE status <> 'running' LIMIT 1").fetchone()
    if row is None:
        pytest.skip("no finished runs in the database")
    res = client.get(f"/runs/{row['id']}/eval-draft")
    assert res.status_code == 200
    body = res.json()
    assert body["run_id"] == str(row["id"])
    assert isinstance(body["input_task"], str)
    assert body["suggestions"][0]["assertion"]["type"] == "run_status"
