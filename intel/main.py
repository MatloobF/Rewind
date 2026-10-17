import threading
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException

from clusters import cluster_failures
from db import connect, get_failure_candidates, get_run, get_run_steps
from drafts import draft_eval
from embeddings import embed, get_model
from failures import run_failures
from loops import detect_loops


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the embedding model in the background (~17 s: torch import + weights),
    # so the server answers at once and the first dashboard visit doesn't wait
    # as long. Tests use TestClient without `with`, which skips this.
    threading.Thread(target=get_model, daemon=True).start()
    yield


app = FastAPI(title="Rewind intel", lifespan=lifespan)


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


@app.get("/runs/{run_id}/eval-draft")
def run_eval_draft(run_id: UUID) -> dict:
    """Proposed assertions for a finished run. Nothing is saved: the web UI lets
    the user edit them, then saves through the Node API (POST /api/evals).
    """
    run = get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    if run["status"] == "running":
        raise HTTPException(status_code=409, detail="run is still running; draft an eval once it has finished")
    return draft_eval(run, get_run_steps(run_id) or [])


def all_failures() -> list[dict]:
    return [f for run, steps in get_failure_candidates() for f in run_failures(run, steps)]


@app.get("/failures")
def list_failures() -> dict:
    return {"failures": all_failures()}


@app.get("/failures/clusters")
def failure_clusters() -> dict:
    # If the startup thread is still loading the model, this waits for it.
    return {"patterns": cluster_failures(all_failures(), embed)}
