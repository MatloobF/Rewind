# CLAUDE.md

This file gives AI coding assistants (Cursor, Claude Code, etc.) context for working on **Rewind**. Read it before making changes.

## Project overview

**Rewind is a time-travel debugger for AI agents.** It records every LLM call and tool call an agent makes, lets you replay a run step by step, and lets you **fork** a run at any step: change a tool result, prompt, or model, then see how the agent would have behaved differently.

Core pieces:

1. **Recorder (Node):** an LLM proxy (drop-in base URL for OpenAI-compatible and Anthropic SDKs, streaming or not) and an MCP proxy that wraps any real MCP server. Both record traffic to Postgres.
2. **Store (PostgreSQL):** runs and steps, with fork relationships forming a tree.
3. **Replay engine (Node):** replays recorded steps deterministically up to a fork point, applies an override, then continues live.
4. **Intelligence layer (Python):** failure clustering, loop/anomaly detection, auto-generated regression evals.
5. **Web UI (React):** run list, step timeline, fork editor, branch graph, run diff, failure dashboard.
6. **Rewind MCP server:** exposes Rewind's data so LLMs can query runs and failures.

This is a **portfolio project built by a developer who is learning**. See "Working with me" below.

## Repository structure

```
rewind/
  server/              # Node: LLM proxy + REST API + replay engine + CLI
    migrations/        # Numbered SQL migrations (001_init.sql, ...)
  mcp-proxy/           # Node: MCP proxy that records tool calls
  rewind-mcp/          # Node: Rewind exposed as an MCP server
  web/                 # React (Vite) frontend
  intel/               # Python (FastAPI): clustering, loop detection, evals
  examples/agent/      # Sample file-organizer agent used to test Rewind
    sandbox/           # The only folder the agent's file tools may touch
  docker-compose.yml
  .env.example         # Committed; copy to .env (never commit .env)
  .gitignore
  CLAUDE.md
  DECISIONS.md         # Design decisions, written in my own words
  .claude/
    skills/            # Reusable workflows (SKILL.md per folder), shared with Cursor
    agents/            # Claude Code subagents
  .cursor/
    agents/            # Cursor subagents (same roles as .claude/agents)
```

## Tech stack

- **Node.js** (LTS), ES modules (`"type": "module"`), Express, `pg`, `@modelcontextprotocol/sdk`, `openai` SDK
- **React** via Vite, Tailwind, `@tanstack/react-query`, `@xyflow/react` (branch graph), `recharts`, `@monaco-editor/react` (fork editor)
- **Python** 3.11+, FastAPI, uvicorn, `psycopg`, `sentence-transformers` (`all-MiniLM-L6-v2`), scikit-learn (`HDBSCAN`)
- **PostgreSQL 16** in Docker
- **LLM (dev):** Ollama locally, model `rewind-qwen` (= `qwen2.5:7b` with a 16k context, built from `examples/agent/Modelfile`), via the OpenAI-compatible API. Must stay free to run.

## Local ports

| Service | Port |
|---|---|
| Postgres | 5432 |
| Rewind server (proxy + API) | 4000 |
| Python intel service | 8000 |
| Web (Vite dev) | 5173 |
| Ollama | 11434 |

## Commands

```bash
docker compose up -d                                  # start Postgres
ollama serve                                          # start local LLM (if not already running)
ollama create rewind-qwen -f examples/agent/Modelfile # once: qwen2.5:7b with a 16k context window
cd server && npm install                              # server deps (express, pg)
cd server && npm run migrate                          # apply new server/migrations/*.sql (safe to re-run, and to run from several processes at once)
cd server && npm test                                 # server tests (hashRequest, run/step API, LLM proxy incl. streaming and the Anthropic route, SSE parsing, eval API, assertion checker, eval runs and `rewind eval`; fake upstreams, needs Postgres, not Ollama)
cd server && npm run dev                              # proxy + API on :4000 (restarts on file changes)
cd web && npm install                                 # web deps (react, vite, tailwind, react-query)
cd web && npm run dev                                 # frontend on :5173, proxies /api to :4000 and /intel to :8000 (failures page at /failures, evals at /evals; "Create eval" on a run page)
cd web && npm test                                    # web logic tests (run diff alignment, loop descriptions, eval form rows, Anthropic message mapping; no browser, no server)
cd intel && python -m venv .venv                      # once: Python virtualenv for the intel service (gitignored)
cd intel && .venv/Scripts/python -m pip install -r requirements.txt   # intel deps (Windows path; .venv/bin/python on macOS/Linux)
cd intel && .venv/Scripts/python -m pytest            # intel tests (health, read-only connection, loop detection, failure extraction, clustering with a fake embedder, eval drafts; needs Postgres)
cd intel && .venv/Scripts/python -m uvicorn main:app --reload --port 8000   # Python service (GET /health, GET /runs/:id/loops, GET /runs/:id/eval-draft, GET /failures, GET /failures/clusters; loads the embedding model in the background at startup, ~17 s)
cd examples/agent && npm install                      # sample agent deps (openai SDK, MCP SDK)
cd mcp-proxy && npm install                           # MCP proxy deps (MCP SDK); the sample agent launches its tools through it
cd mcp-proxy && npm test                              # MCP proxy tests (passthrough, recording against a fake API, fail-open, fork replay/override and fail-closed; no Postgres)
cd rewind-mcp && npm install                          # Rewind MCP server deps (MCP SDK, zod for tool input schemas)
cd rewind-mcp && npm test                             # Rewind MCP server tests (run, intel and eval tools, step summaries for both LLM formats and clipping, API- and intel-down errors, stdio; fake HTTP services, no Postgres)
cd examples/agent && npm run seed                     # reset the sandbox to the messy starting files
cd examples/agent && npm run seed:failures            # record 10 scripted failing runs via the API for the intel service (server must be running; --force to add again)
cd examples/agent && npm test                         # sample agent tests (safePath, tools, seed, loop, MCP server + client)
node examples/agent/index.js "sort the files"         # run the sample agent directly (~3 min on CPU)
node examples/agent/mcp-server.js                     # the file tools as a stdio MCP server (the agent launches it itself)
node mcp-proxy/index.js -- <command> [args...]        # wrap any stdio MCP server; records tool calls when REWIND_RUN_ID is set
node rewind-mcp/index.js                              # Rewind as a stdio MCP server (read-only tools: list_runs, get_run, get_failure_patterns, get_run_loops, list_evals, get_eval); reads REWIND_SERVER_URL and INTEL_URL
claude mcp add rewind -- node C:/Projects/Rewind/rewind-mcp/index.js   # once: register it with Claude Code (local scope); the tools appear in a new session, check with /mcp
claude mcp remove rewind -s local                     # unregister it (a committed .mcp.json for Claude Code and Cursor is planned for Phase 10)
cd server && npm link                                 # once: installs the `rewind` command globally
rewind run --name "test" -- node examples/agent/index.js "sort the files"   # recorded run, LLM + tool steps (server must be running)
rewind eval <eval-id>...                              # run saved evals one at a time, print PASS/FAIL and why; exit 0 only if all pass (server must be running; the agent's output shows in the server's terminal)
rewind eval --all                                     # run every saved eval, oldest first
```

Update this section when scripts are added or renamed.

## Environment variables

- `DATABASE_URL`: e.g. `postgres://postgres:rewind@localhost:5432/rewind`
- `UPSTREAM_URL`: real LLM endpoint the proxy forwards OpenAI-format calls to (default `http://localhost:11434`)
- `ANTHROPIC_UPSTREAM_URL`: endpoint for Anthropic-format calls (`/r/:runId/v1/messages`). Defaults to `UPSTREAM_URL`, since Ollama serves `/v1/messages` too; set `https://api.anthropic.com` for the real API (optional, paid).
- `REWIND_SERVER_URL`: Rewind server URL used by the CLI and MCP proxy, and by the server itself to tell forked agents where it is (default `http://localhost:4000`)
- `REWIND_RUN_ID`: set by the CLI (or the server, for forks) for each run; used by the MCP proxy
- `REWIND_BASE_URL`: set by the CLI; the agent uses it as its LLM base URL
- `INTEL_URL`: Python service URL (default `http://localhost:8000`). Read by the Rewind MCP server (`rewind-mcp`). The web UI doesn't read it yet: the Vite dev proxy sends `/intel` to `:8000` directly. Wire that up when deploying (Phase 10).
- The intel service reads `DATABASE_URL` from the real environment only, not from `.env` (the Node scripts load `../.env` with `--env-file`). If your `.env` points somewhere other than the default, set it in the shell before starting uvicorn.

Never commit real API keys. Keep secrets in `.env` (gitignored) and document every variable in `.env.example`. Never expose secrets to the frontend: in Vite, any `VITE_` variable is bundled into the browser.

## Database schema

Core tables below. Keep it this small unless there is a strong reason to split.

- **`runs`**
  - `id` (UUID), `name`, `command` (JSONB argv array, e.g. `["node", "examples/agent/index.js", "sort the files"]`), `cwd` (TEXT). Forks and evals re-launch with `spawn(argv[0], argv.slice(1), { cwd })`, never through a shell.
  - `status` (`running | success | failed`)
  - `parent_run_id` (fork parent, NULL for originals), `fork_step` (`idx` of the overridden step), `fork_override` (JSONB)
  - `diverged_at_step` (INT, NULL if replay never diverged). Divergence is separate from `status` because a diverged run can still succeed or fail.
  - `created_at`
- **`steps`**
  - `id`, `run_id`, `idx`, `type` (`llm | tool`), `request` (JSONB), `response` (JSONB), `request_hash`, `latency_ms`, `tokens_in`, `tokens_out`, `error`
  - `format` (Phase 9): `openai | anthropic` for `llm` steps, set from the proxy route; NULL for `tool` steps (a CHECK enforces both). Readers branch on it to read `request`/`response`; replay only uses a parent step of the same format.
  - `response` is always stored in the **non-streaming** shape (a `chat.completion` or a `message`), even when the call streamed: the proxy rebuilds it from the SSE events. Anthropic `tokens_in` = `input_tokens` + both cache token counts.
  - `replayed` (BOOLEAN, default false): true when the response was served from the parent run instead of a live call
  - `response` is NULL while a live call is in progress (step started, not finished). A step left NULL means the agent died mid-call.
  - `UNIQUE (run_id, idx)`
- **`evals`** (Phase 7): `id`, `source_run_id` (NULL once that run is deleted), `input_task` (a label; the task is in `command`), `command` (JSONB argv) and `cwd` (both copied from the source run), `setup` (JSONB argv or NULL, run before the agent, e.g. to reseed the sandbox), `assertions` (JSONB array), `created_at`
- **`eval_results`** (Phase 7): `id`, `eval_id`, `run_id`, `passed` (BOOLEAN, NULL while the run is going), `failures` (JSONB: which assertions failed and why), `created_at`. Only the server writes these, when an eval run it launched exits.

Indexes: `steps (run_id, idx)`, `runs (parent_run_id)`, `eval_results (eval_id, created_at)`. Add a GIN index on JSONB columns only if queries need it.

Schema changes go in numbered SQL migration files (e.g. `server/migrations/001_init.sql`), never ad-hoc edits.

### Step numbering and hashing

- **`idx` is 0-based** and shared by LLM and tool steps in one run.
- **Only the Rewind server assigns `idx`**, inside a transaction that first locks the run row (`SELECT ... FROM runs WHERE id = $1 FOR UPDATE`), then takes next `idx` = `COALESCE(MAX(idx), -1) + 1` for that run. The lock stops the LLM and MCP proxies from getting the same `idx`. Nothing else computes or writes `idx`.
- **`idx` is assigned when a step starts, before the live call** (see "Step recording" below), so the server can decide replay vs. live for that `idx`.
- **`request_hash`** = SHA-256 of a **canonical JSON** of the request: keys sorted recursively, with only transport fields removed (`stream`, `stream_options`). Everything else, including `model` and `temperature`, stays in the hash. Plain `JSON.stringify` is not allowed for hashing because key order is not guaranteed. Use one shared `hashRequest()` function everywhere.

## API surface (grows by phase)

- `POST /r/:runId/v1/chat/completions`: LLM proxy, OpenAI format (Phase 2), to `UPSTREAM_URL`
- `POST /r/:runId/v1/messages`: LLM proxy, Anthropic format (Phase 9), to `ANTHROPIC_UPSTREAM_URL`
- Both routes stream when the request has `stream: true` (Phase 9): SSE chunks are forwarded unchanged as they arrive (an upstream that breaks off breaks the agent's stream too), and a replayed or overridden step is sent back as a stream to an agent that asked for one. Errors stay JSON with their status.
- `POST /api/runs`: create a run (used by the CLI)
- `PATCH /api/runs/:id`: update status when the agent exits (or when the CLI catches Ctrl+C: `failed`)
- `POST /api/runs/:id/steps`: **start** a step. Body `{ type, request }`. Server assigns `idx`, saves the request, returns `{ idx, mode }`, plus the parent's `{ response, error }` for `replay`
- `PATCH /api/runs/:id/steps/:idx`: **finish** a live step with `{ response, error, latency_ms, tokens_in, tokens_out }`

### Step recording (start + finish)

1. The proxy starts the step. The server locks the run, assigns `idx`, inserts the row (`response` NULL) and returns a `mode`:
   - `live`: make the real call, then PATCH the result. (Phase 2–4: always `live`.)
   - `replay` (Phase 5): the row is already complete with the parent's response and `replayed = true`. Return `response` to the agent, make no call, don't PATCH.
   - `override` (Phase 5): apply `fork_override` as Rule 6 says. `{ kind: "response", response }` returns `{ response }` (row already finished, no call, no PATCH); `{ kind: "request", request }` returns `{ request }` to send live, then PATCH. The sent request keeps the agent's own `stream`/`stream_options`, not the edit's.
2. All replay decisions are made in the server, in one place. The MCP proxy uses these two HTTP routes. The LLM proxy lives in the server, so it calls the same functions directly.
- `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/tree` (Phase 3)
- `POST /api/runs/:id/fork`: fork a finished run. Body `{ fork_step, fork_override?, name?, setup? }`; `setup` is an optional argv run (no shell, in the run's `cwd`) before the agent, e.g. `["node", "examples/agent/seed.js"]`. Returns 201 with the new run at once; the server launches the agent in the background and sets the status when it exits (Phase 5). Replayed tool steps don't run, so `setup` resets the world to the run's start, not to its state at the fork step; a fork after a file-changing tool call starts from the wrong state.
- `POST /api/evals`: save an eval from a finished run. Body `{ source_run_id, input_task, assertions, setup? }`; copies the run's `command` and `cwd`. 404 for an unknown run, 409 for a running one (Phase 7)
- `POST /api/evals/:id/runs`: run an eval. Creates a fresh live run named `[eval] <input_task>` (no parent, nothing replayed) and its `eval_results` row with `passed` NULL, returns 201 `{ run, result }` at once, launches the agent after the eval's `setup`, and fills in `passed` and `failures` when it exits. Run evals that share files one at a time (`rewind eval` does).
- `GET /api/evals` (each with `latest_result` and `result_count` / `checked_count` / `passed_count`), `GET /api/evals/:id` (with all `results`, newest first, each with `run_status`)

## Key design rules (do not break these)

1. **Run ID lives in the URL.** The LLM proxy route is `/r/:runId/v1/...`, so any agent can be recorded by changing only its base URL.
2. **The proxy is transparent.** It forwards requests unchanged and returns upstream responses unchanged (including status codes). Recording must never alter agent behavior in record mode.
3. **One step sequence per run, one owner of writes.** LLM and tool steps share `idx`. The MCP proxy records tool steps through the start/finish step routes, never by writing to the DB directly. The Python service reads Postgres **read-only**; any writes go through the Node API.
4. **Never `console.log` in stdio MCP servers.** Stdout carries the MCP protocol. Log with `console.error`.
5. **Record MCP tool errors.** Tools often return `isError: true` instead of throwing; set the `error` column in that case too.
6. **Replay rules (Phase 5),** for a fork run with `fork_step = N`, decided by the server when a step starts (so both proxies behave the same):
   - `idx < N`: return the parent's recorded response for the same `idx`, record it in the fork run with `replayed = true`, and make no live call.
   - `idx = N`: apply `fork_override` (edited response, or edited request sent live).
   - `idx > N`: go live and record normally.
   - Before returning a recorded response, compare `request_hash`. On mismatch, set `diverged_at_step` and switch to live for the rest of the run.
7. **Agents are assumed sequential** for now (one call at a time). Parallel calls are a later upgrade; don't silently break the `idx` assumption.
8. **Eval assertions are structured JSON** checked by deterministic code (e.g. `must_not_call_tool`, `max_steps`, `final_output_contains`), not judged by an LLM.
9. **Sample agent stays sandboxed.** All file tools resolve paths inside `examples/agent/sandbox` via `safePath`. Never weaken this.
10. **Agent loop has a max-step limit.** Keep a hard cap to prevent infinite loops.
11. **Free to run.** Default to Ollama and local embeddings. Paid APIs must be optional, with a free fallback.

## Build roadmap

Work in this order. Each phase should leave the project in a working state.

- [x] **Phase 0:** Setup (repo structure, Docker Postgres, Ollama)
- [x] **Phase 1:** Sample file-organizer agent (agent loop, 4 tools, sandbox)
- [x] **Phase 2:** LLM recording proxy, schema, `rewind run` CLI (non-streaming first)
- [x] **Phase 3:** REST API (`/api/runs`, `/api/runs/:id`, `/api/runs/:id/tree` via recursive CTE) + React run list and timeline
- [x] **Phase 4:** MCP proxy; move sample agent's tools to MCP. Bonus demo: add the proxy to Claude Code (`claude mcp add`) or Cursor's MCP config and record their tool calls.
- [x] **Phase 5:** Replay and fork engine; fork editor, branch graph, diff view
- [x] **Phase 6:** Python service: failure clustering, loop detection, failure-patterns dashboard
- [x] **Phase 7:** Auto-generated evals, `eval_results`, and `rewind eval` runner
- [x] **Phase 8:** Rewind as an MCP server (demo: query it from Claude Code or Cursor)
- [x] **Phase 9:** Streaming support and the Anthropic `/v1/messages` route
- [ ] **Phase 10:** Docker, deploy, README, demo. Headline demo: record Claude Code's LLM calls by pointing `ANTHROPIC_BASE_URL` at the Rewind proxy, so Rewind captures both its LLM and tool calls. (Cursor's own LLM calls go through Cursor's servers and can't be proxied.) Claude Code also calls side routes such as `/v1/messages/count_tokens`, which the proxy doesn't serve yet (404): decide whether to pass them through unrecorded.

Tick boxes as phases are completed.

## Code conventions

- Small, readable functions over clever abstractions. No premature generalization.
- Async/await everywhere; no callback-style code.
- Parameterized SQL only (`$1, $2`). Never build SQL with string concatenation.
- Validate external input at API boundaries.
- Errors returned to agents as `{ error: message }`; errors in the API return proper HTTP status codes.
- Python: type hints, small functions, keep the FastAPI app thin.
- React: function components and hooks; data fetching through React Query.
- Commit messages: short imperative summary (e.g. "Add recursive CTE for run tree").

## Testing

- Highest priority: **the replay engine** (record mode passthrough, replay before fork, override at fork, live after fork, divergence detection, `fork_step` off-by-one cases).
- Also test: `hashRequest()` stability (same request with different key order gives the same hash), `safePath` sandbox escapes, eval assertion checks, loop detection.
- Node: `node --test` or Vitest. Python: pytest.
- Run relevant tests before saying a change is done.

## Working with me

I'm building this to learn and to show on my resume, so:

- **Explain non-obvious decisions** briefly when you make them, so I can explain them in interviews.
- **Record significant design decisions in `DECISIONS.md`** as a short entry: the decision, why, and the alternative rejected.
- **Build one step at a time.** Don't generate a whole phase in one go unless I ask. Tell me what you're about to change first for anything large.
- **Prefer simple code I can understand** over production-grade complexity.
- **Don't add new dependencies** without saying why.
- If something in this file conflicts with what I ask, point it out and ask before deviating.
- Update the roadmap checkboxes and the Commands section when they change.

## Working across two tools

I use both **Claude Code** (terminal) and **Cursor** (editor) on this repo. Both read this file.

- Only one tool edits the code at a time. Commit before switching tools.
- Before starting, check `git status` and read recent commits, since the other tool may have changed things.
- Skills live in `.claude/skills/` so both tools share them. Subagents exist in both `.claude/agents/` and `.cursor/agents/`; keep the two copies in sync when one changes.
