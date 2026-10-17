from uuid import UUID

from fastapi import FastAPI, HTTPException

from clusters import cluster_failures
from db import connect, get_failure_candidates, get_run_steps
from embeddings import embed
from failures import run_failures
from loops import detect_loops

app = FastAPI(title="Rewind intel")


@app.get("/health")
def health() -> dict:
    with connect() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}


@app.get("/runs/{run_id}/loops")
def run_loops(run_id: UUID) -> dict:
    steps = get_run_steps(run_id)
    if steps is None:
        raise HTTPException(status_code=404, detail="run not found")
    return {"run_id": str(run_id), "loops": detect_loops(steps)}


def all_failures() -> list[dict]:
    return [f for run, steps in get_failure_candidates() for f in run_failures(run, steps)]


@app.get("/failures")
def list_failures() -> dict:
    return {"failures": all_failures()}


@app.get("/failures/clusters")
def failure_clusters() -> dict:
    # The first call loads the embedding model (a few seconds); later calls reuse it.
    return {"patterns": cluster_failures(all_failures(), embed)}
