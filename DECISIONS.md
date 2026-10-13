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

## The sample agent has no delete tool

**Decision:** The agent gets four tools: `list_files`, `read_file`, `create_folder`, `move_file`. `move_file` refuses to overwrite. All paths go through `safePath`, which keeps them inside `examples/agent/sandbox`.

**Why:** No sequence of tool calls can destroy a file, even when a small model gets confused. Any mistake can be undone by moving files back, or by `npm run seed`.

**Rejected:** A `delete_file` tool. Organizing files never needs it, and the cost of a bad call would be lost data.

## Agent output: answer on stdout, logs on stderr, result in the exit code

**Decision:** `index.js` prints only the final answer to stdout and all progress to stderr. It exits 0 when the model finishes and 1 on an error or when it hits the step limit.

**Why:** `rewind run` can set the run's `success`/`failed` status from the exit code alone, for any agent and not just this one. Keeping logs on stderr means the answer can be captured cleanly.

**Rejected:** Having the agent report its own status to the Rewind API. Every agent would then need Rewind-specific code.

## The agent's requests are deterministic

**Decision:** `temperature: 0`, a fixed system prompt with no timestamps or IDs, and `list_files` sorted by plain code-unit order (not `localeCompare`).

**Why:** Replay matches requests by `request_hash`. If the same task produced slightly different requests, every replay would look like a divergence.

**Rejected:** A friendlier prompt that includes the current date, and locale-aware sorting. Both change the request bytes from run to run or from machine to machine.

## Step cap counts LLM calls, and tool calls run one at a time

**Decision:** The loop stops after 25 LLM calls. When one response contains several tool calls, the agent runs them in order with `await`, not `Promise.all`.

**Why:** The cap is a hard stop against infinite loops. qwen2.5 often asks for many tool calls in one response (13 in the first real run), and running them one by one keeps the "sequential agent" assumption that `idx` depends on.

**Rejected:** Running tool calls in parallel (it breaks the `idx` order), and a cap of 15 (too tight if the model makes one tool call per response).
