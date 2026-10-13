# Decisions

Short record of design choices: what we picked, why, and what we rejected.

## Postgres runs in Docker, not as a Windows install

**Decision:** PostgreSQL 16 is a single service in `docker-compose.yml`. The app talks to it at `localhost:5432`.

**Why:** The version is pinned, and `docker compose up -d` is the same setup on any machine. The database password lives only in Compose and `.env`, which is gitignored.

**Rejected:** Installing Postgres directly on Windows. That ties the project to one OS and makes the version easy to drift.

## Ollama stays on the host

**Decision:** The dev LLM is Ollama on the machine (`ollama serve`, model `qwen2.5:7b`). Rewind reaches it at `http://localhost:11434`. It is not a Compose service.

**Why:** The model download is large and machine-specific. Keeping Ollama outside Compose means Postgres can start even when the model is not pulled yet. The project stays free to run.

**Rejected:** Putting Ollama in Docker. Startup would depend on a multi-gigabyte image, and GPU access on Windows is harder than calling the host daemon.

## Phase 0 is layout only

**Decision:** This phase creates folders, Compose, `.env.example`, and `.gitignore`. No Node packages, SQL, or agent code yet.

**Why:** Each later phase should start from a repo that already runs Postgres. Adding the agent or the proxy now would mix setup with behavior.

**Rejected:** Generating the sample agent and the proxy in the same step. Those are Phases 1 and 2.
