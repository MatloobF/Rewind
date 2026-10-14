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

## Steps are recorded in two calls: start, then finish

**Decision:** A proxy first calls `POST /api/runs/:id/steps` with the request. The server locks the run, assigns `idx`, saves the request, and answers with a mode: `live`, `replay` (with the recorded response), or `override`. After a live call, the proxy sends the result with `PATCH /api/runs/:id/steps/:idx`.

**Why:** Replay has to know a step's `idx` *before* the call, to decide whether to call at all. Only the server assigns `idx`, so the server has to be asked first. As a bonus, every replay rule lives in one place (the server) and both proxies just follow the mode they're given.

**Rejected:** Posting the whole step after the call (the original plan). That works for recording, but Phase 5 would need a separate "should I replay?" call, and that check could race with the write.

## Lock the run row before assigning `idx`

**Decision:** The start-step transaction runs `SELECT ... FROM runs WHERE id = $1 FOR UPDATE` before computing `COALESCE(MAX(idx), -1) + 1`.

**Why:** The LLM proxy and the MCP proxy write to the same run. Without the lock, two requests at the same moment could both read the same `MAX(idx)` and one insert would fail on `UNIQUE (run_id, idx)`. With it, the second one waits.

**Rejected:** Retrying on a unique-constraint error (more code, harder to reason about), and Postgres advisory locks (work, but less obvious than locking the row the steps belong to).

## Store the agent command as an argv array, not a string

**Decision:** `runs.command` is a JSONB array like `["node", "examples/agent/index.js", "sort the files"]`, plus `runs.cwd`. Forks and evals re-launch it with `spawn(argv[0], argv.slice(1), { cwd })` and no shell.

**Why:** A command string has to be re-parsed by a shell, and quoting rules differ between PowerShell and bash. A task containing quotes or spaces could break, and a crafted one could inject extra commands. An argv array goes straight to the program. `cwd` matters because relative paths in the command only work from the original folder.

**Rejected:** `command TEXT` run through a shell.

## Hash everything except transport fields

**Decision:** `hashRequest()` drops only `stream` and `stream_options` before hashing.

**Why:** Those change how the response is delivered, not what the model is asked. Everything else, including `model` and `temperature`, changes the answer, so a change there should count as a different request.

**Rejected:** Also dropping `model`/`temperature`. A fork that switches models would then wrongly match the parent's recorded steps.

## Ctrl+C marks a run failed; hard kills are accepted

**Decision:** `rewind run` catches SIGINT/SIGTERM, stops the agent, and sets the run to `failed`. If the CLI is killed hard (terminal closed, Task Manager), the run can stay `running`.

**Why:** It covers the common case with a few lines of code. Unfinished steps keep `response` NULL, which honestly shows where the agent died.

**Rejected:** A server timer that marks quiet runs `failed`. On CPU-only Ollama one LLM call can take minutes, so a timeout would misjudge slow runs as dead. It can be added later if stuck runs become a real problem.

## Bigger Ollama context through a committed Modelfile

**Decision:** `examples/agent/Modelfile` builds `rewind-qwen` (`qwen2.5:7b` with `num_ctx 16384`), and the agent uses that model.

**Why:** Ollama's default context is 4096 tokens. Past that it silently drops the oldest messages, including the system prompt, so the agent would forget its instructions with no error. Recorded runs would then be misleading. A Modelfile in the repo means anyone cloning gets the same setting.

**Rejected:** Setting `OLLAMA_CONTEXT_LENGTH` on `ollama serve`. It works, but it's machine setup outside the repo and easy to forget. The OpenAI-compatible API has no `num_ctx` request option.

## Split the last phase in two

**Decision:** Phase 9 is streaming plus the Anthropic `/v1/messages` route. Phase 10 is Docker, deploy, README and demo.

**Why:** Streaming changes how the proxy records responses and is real engineering. Packaging and docs are a different kind of work. Each phase should end in a working state, and one phase holding both was too big.

**Rejected:** Keeping one large Phase 9.

## A 30-line migration runner instead of a library

**Decision:** `server/src/migrate.js` applies `server/migrations/*.sql` in name order. Each file runs once, in its own transaction, and is recorded in a `schema_migrations` table. Run it with `npm run migrate`.

**Why:** Plain SQL files are easy to read and review, and the runner is short enough to explain line by line. Running each file in a transaction means a broken migration leaves no half-applied schema.

**Rejected:** `node-pg-migrate` or an ORM's migrations. They add a dependency and their own file format, for features (down migrations, JS migrations) this project doesn't need yet.

## Canonical JSON is hand-written, not a library

**Decision:** `canonicalJson()` in `server/src/hash.js` sorts object keys at every level and keeps array order. `hashRequest()` hashes its output with SHA-256.

**Why:** `JSON.stringify` writes keys in the order the object was built, so two equal requests can produce different strings. Array order is kept because order in `messages` and `tools` changes what the model sees. The function is about 15 lines and fully covered by tests.

**Rejected:** A canonicalization package (e.g. RFC 8785 / JCS). It's more than we need and one more dependency.

## A step can be finished only once

**Decision:** `PATCH /api/runs/:id/steps/:idx` only updates a step whose `response` and `error` are both still NULL. A second finish gets `409 Conflict`. Starting a step on a run that is no longer `running` is also a `409`.

**Why:** A finished step is a historical record that replay will read. If a retry or a bug could overwrite it, a fork could replay a response the original run never saw. Refusing steps on finished runs catches a proxy that keeps writing after the CLI marked the run done.

**Rejected:** Letting the last PATCH win. It's simpler, but it silently rewrites history.

## Integration tests use the real Postgres

**Decision:** `server/test/api.test.js` starts the Express app on a random port and talks to the Docker Postgres. Test runs are named `api-test` and deleted afterwards.

**Why:** The thing most worth testing, the `FOR UPDATE` lock that keeps `idx` unique, only exists in a real database. A test that starts 20 steps at once fails with a duplicate-key error when the lock is removed, and passes with it.

**Rejected:** Mocking `pg`. The mock would just repeat our assumptions about locking, not check them.

## The proxy forwards raw bytes, and parses a copy to record

**Decision:** The `/r` route reads the request body as raw bytes and sends exactly those bytes upstream. It parses a separate copy for the `steps.request` column. The upstream status, content type and body bytes go back to the agent unchanged, error statuses included.

**Why:** Rule 2 says recording must never change what the agent sends or gets. Parsing and re-serializing could change key order, whitespace or number formatting. The stored copy is only for recording and hashing, and `hashRequest` doesn't care about key order.

**Rejected:** Using `express.json()` and forwarding `JSON.stringify(req.body)`. It's simpler, but it isn't byte-for-byte transparent.

## How the proxy records failures

**Decision:** An upstream error status (e.g. 404 for an unknown model) is passed through and saved with `error = "upstream HTTP <status>: <message>"`, keeping the error body in `response`. If the upstream can't be reached, the agent gets a `502 { error }` and the step is saved with only `error`. A `stream: true` request is refused with a 400 before any step is created.

**Why:** Failed calls are exactly what a debugger needs to show, so they are steps too. Refusing streaming outright is clearer than half-recording a stream; streaming is Phase 9.

**Rejected:** Not recording failed calls, which would hide the moment a run went wrong.

## Only a few headers are forwarded

**Decision:** The proxy forwards `content-type`, `accept` and `authorization` to the upstream.

**Why:** These are the ones that change the result. `authorization` is needed when the upstream is a paid API. `host` and `content-length` are set by `fetch`. The OpenAI SDK's `x-stainless-*` headers are telemetry.

**Rejected:** Forwarding every header. Hop-by-hop headers like `connection` and a stale `host` can break the upstream request.

## `rewind run` talks only to the API, and passes the agent's exit code through

**Decision:** The CLI creates the run with `POST /api/runs`, spawns the agent with `REWIND_RUN_ID` and `REWIND_BASE_URL=<server>/r/<id>/v1` added to its environment, then sets the status with `PATCH /api/runs/:id`. It exits with the agent's own exit code (130 after Ctrl+C), and its `[rewind]` messages go to stderr.

**Why:** Rule 3: the server is the only writer, so the CLI needs no database credentials. Passing the exit code and keeping stdout clean means `rewind run -- <cmd>` can replace `<cmd>` in a script without changing what that script sees. If the server is down, the CLI stops before starting the agent rather than running it unrecorded.

**Rejected:** Writing runs straight to Postgres from the CLI, and running the agent anyway when the server is unreachable (you'd think it was recorded when it wasn't).

## The command must start with a real executable

**Decision:** `spawn(argv[0], argv.slice(1))` with no shell, as for forks. On Windows that means `node ...`, not `npm run ...` (`npm` is a `.cmd` wrapper, and Node won't run those without a shell).

**Why:** It's the same rule as storing argv instead of a command string: no shell means no quoting problems and no injection. A test passes `say "hi" & echo pwned` as an argument and checks it arrives unchanged.

**Rejected:** `shell: true` on Windows to allow `.cmd` files. It brings back the quoting and injection problems that argv storage was chosen to avoid.

## The tree endpoint walks up to the root, then down, and returns a flat list

**Decision:** `GET /api/runs/:id/tree` uses one recursive CTE in two parts. `ancestors` follows `parent_run_id` up from the given run to the root. `tree` then follows children down from that root. The result is `{ root_id, runs: [...] }`, a flat list where each run carries its `parent_run_id` and `fork_step`.

**Why:** Asking from any run (root, fork or fork of a fork) gives the same whole tree, so the UI can show the branch graph from any run page. A flat list maps straight to the nodes and edges the graph library wants, and Postgres doesn't build nested JSON easily.

**Rejected:** Only walking down from the given run (a fork's page would miss its parent and siblings), and returning nested `children` arrays (the UI would have to flatten them again for the graph).

## The web UI reaches the API through Vite's dev proxy, not CORS

**Decision:** The browser only talks to Vite on :5173. `vite.config.js` forwards `/api` to the Rewind server on :4000, and the frontend fetches relative paths like `/api/runs`.

**Why:** To the browser it's one origin, so the server needs no CORS headers or extra dependency. The frontend has no hard-coded server URL. In Phase 10 the server can serve the built `web/dist` itself, and the same relative paths keep working.

**Rejected:** Adding the `cors` middleware to the server and fetching `http://localhost:4000` from the browser. It's one more dependency and one more setting to get wrong when deploying.

## Tailwind v4 through its Vite plugin

**Decision:** Tailwind is set up with `@tailwindcss/vite` and a single `@import "tailwindcss"` line in `src/index.css`.

**Why:** Tailwind v4 finds class names in the source files by itself, so it needs no `tailwind.config.js` or `postcss.config.js`. That means fewer files to understand.

**Rejected:** The v3 setup (PostCSS plus a config file listing the `content` paths). It's what older tutorials show, but it's no longer needed.

## The run list polls only while a run is recording

**Decision:** The run list query sets React Query's `refetchInterval` to 2 seconds while any run has `status = 'running'`, and turns polling off otherwise.

**Why:** A recording run gets new steps and then a final status, and the list should show that without a reload. Polling is a single line of code, and an idle list makes no requests.

**Rejected:** Pushing updates over WebSockets or Server-Sent Events. That's real-time, but it adds a connection to manage on the server for a local tool where a 2-second delay doesn't matter.

## Routing with `react-router`

**Decision:** Pages live at real URLs (`/`, `/runs/:id`) using `react-router`'s `BrowserRouter`.

**Why:** Back and forward buttons work, and a run's URL can be shared or bookmarked. Later phases add more pages (diff, failures dashboard), so a hand-written router would keep growing.

**Rejected:** About 15 lines of home-made routing on `location.hash`. It needs no dependency, but it means maintaining my own router.
