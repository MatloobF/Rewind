import threading
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException

from clusters import cluster_failures
from db import connect, get_failure_candidates, get_run_steps
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


def all_failures() -> list[dict]:
    return [f for run, steps in get_failure_candidates() for f in run_failures(run, steps)]


@app.get("/failures")
def list_failures() -> dict:
    return {"failures": all_failures()}


@app.get("/failures/clusters")
def failure_clusters() -> dict:
    # If the startup thread is still loading the model, this waits for it.
    return {"patterns": cluster_failures(all_failures(), embed)}
