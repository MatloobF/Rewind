from fastapi import FastAPI

from db import connect

app = FastAPI(title="Rewind intel")


@app.get("/health")
def health() -> dict:
    with connect() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}
