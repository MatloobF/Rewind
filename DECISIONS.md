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

## The timeline shows only the messages that are new at each LLM step

**Decision:** For an LLM step, the detail panel shows the response first. Below it are only the request messages added since the previous LLM step, which is usually the assistant's last reply plus the tool results. A toggle shows the full conversation, and the raw request and response JSON are always available.

**Why:** Every chat completion request resends the whole history, so step 2 of a short run already carries 19 messages, and later steps repeat everything before them. The new messages are what the model saw for the first time, and that's what you need when asking "why did it do that here?". The count comes from the previous LLM step's `messages.length`, so no extra data is stored.

**Rejected:** Showing every message of every request, which buries the change under repeated history. Also rejected: diffing requests on the server and storing the difference, which is extra schema for something the UI can work out.

## The selected step is in the URL

**Decision:** The run page keeps the selected step in the query string (`/runs/:id?step=2`).

**Why:** A link can point at the exact step where an agent went wrong, and reloading keeps your place. It's one `useSearchParams` call.

**Rejected:** Keeping the selection in React state only, which is lost on reload and can't be shared.

## The file-tools MCP server uses the SDK's low-level `Server` and reports failures with `isError`

**Decision:** `examples/agent/mcp-server.js` builds on the SDK's low-level `Server` with `setRequestHandler`. It serves the JSON Schemas already in `tools.js`, mapped to MCP's `{ name, description, inputSchema }`. A tool that fails returns a normal result with `isError: true` and the `{ error }` JSON as text. It doesn't throw a protocol error. The sandbox root can be passed only to `createServer()` for tests, and the stdio entry point always uses the real sandbox.

**Why:** The tool definitions stay in one place, so the schemas the model sees can't drift from the ones in `tools.js`, and no `zod` dependency is needed. With `isError`, the agent still gets the error message and can fix its next call, which is how the tools behaved before MCP. It's also what Rule 5 records in the `error` column. Not having a flag or env var for the root means nothing outside the code can point the tools at another folder (Rule 9).

**Rejected:** The high-level `McpServer.registerTool()`, which needs every schema rewritten in `zod`. Also rejected: throwing on tool failure, which turns a fixable mistake into a protocol error the model never sees.

## The agent calls its tools through a small `{ definitions, call }` interface

**Decision:** `runAgent` takes a required `tools` option shaped `{ definitions, call(name, args) → text, close() }`. `toolClient.js` has two versions. `connectMcpTools()` launches `mcp-server.js` over stdio, and `index.js` uses it. `localTools(root)` runs `tools.js` in-process, and the tests use it. MCP's tool list is mapped back to the exact OpenAI schemas, and the tool result text is passed through unchanged.

**Why:** A test checks that moving to MCP didn't change a single byte of the LLM requests. That matters because replay matches requests by hash. The agent loop doesn't need to know about MCP, and its tests stay fast with no subprocesses. `tools` is required rather than defaulting to in-process tools, so the real agent can't quietly skip MCP (and later the recording proxy).

**Rejected:** Having the agent call the MCP `Client` directly inside the loop, which would force every agent test to start a server. Also rejected: a default of in-process tools, which would be a hidden second path around the proxy.

## The MCP proxy is an SDK `Server` in front of an SDK `Client`, and forwards only tools

**Decision:** `mcp-proxy` acts as an MCP server to the agent and as an MCP client to the real server (`node mcp-proxy/index.js -- <server argv>`). It forwards `tools/list` and `tools/call` and returns results unchanged, `isError` results included. Protocol errors keep their code, message and data. The SDK adds an `MCP error <code>: ` prefix to the message, and the proxy strips it once so the agent doesn't see it twice. The real server gets the proxy's whole environment and its stderr. When the agent closes the proxy's stdin, the proxy closes the real server the same way and exits.

**Why:** Recording needs to pair each tool call with its result, and the SDK already does that pairing. The proxy is about 40 lines that are easy to read, and tool calls are what Rewind records. Tests compare the same calls direct and through the proxy, to keep it transparent (Rule 2).

**Rejected:** Relaying raw JSON-RPC lines between the two pipes. It forwards everything (resources, prompts, notifications) for free, but means hand-matching request ids to responses to record anything. Resources and prompts can be added to the SDK version later if a demo needs them.

## The sample agent always launches its tools through the proxy

**Decision:** `connectMcpTools()` always starts `mcp-proxy -- node mcp-server.js`. When `rewind run` isn't involved, `REWIND_RUN_ID` is unset and the proxy just passes calls through. The agent passes `REWIND_RUN_ID` and `REWIND_SERVER_URL` explicitly, because the SDK's stdio transport only hands a short list of "safe" variables to the process it launches.

**Why:** One code path, so the setup that's tested is the same one that gets recorded. A passthrough hop costs little.

**Rejected:** Adding the proxy only when `REWIND_RUN_ID` is set. That's two launch paths, and the recorded one would be the less tested.

## The MCP proxy records tool calls through the API and fails open

**Decision:** When `REWIND_RUN_ID` is set, each `tools/call` becomes a tool step. The proxy sends `POST /api/runs/:id/steps` with `{ type: 'tool', request: { name, arguments } }`, makes the real call, then `PATCH`es `{ response, error, latency_ms }`. A missing `arguments` is stored as `{}`. An `isError` result keeps the whole result as `response`, and its text goes in `error` (Rule 5). A protocol error has no `response`, and `error` is `MCP error <code>: <message>`. `tools/list` isn't recorded. If the API is down, slow (5-second timeout), or refuses the step (for example, 409 because the run has finished), the proxy logs to stderr and makes the real call anyway. If saving the result fails, it still returns the result.

**Why:** Recording must never change what the agent sees (Rule 2). Losing a recorded step is better than breaking a tool call in someone's agent. The proxy goes through the same start/finish routes as the LLM proxy, so Phase 5 can make replay decisions for both in `startStep`. The tests use a fake API on `node:http`, so they need no Postgres. The routes themselves are tested in `server/`.

**Rejected:** Failing closed, which returns an error to the agent when recording fails. The LLM proxy does effectively fail closed when the run isn't running, but that's because its run id is in the URL, so there's no unrecorded path to fall back to. **Revisit in Phase 5:** for a fork run, silently going live when the API is unreachable would give wrong replay results. A fork should probably fail closed.

## Replay is decided in `startStep`, and anything unexpected counts as divergence

**Decision:** For a fork with `fork_step = N`, `startStep` compares each step at `idx <= N` with the parent's step at the same `idx`. If they match, a step before N is saved straight away as a complete row with `replayed = true`, copying the parent's `response`, `error` and tokens, and the proxy gets `{ mode: 'replay', response, error }`. `latency_ms` stays NULL because no call was made. Four things count as divergence: a different `request_hash`, a different step type, a parent with no step at that `idx`, or a parent step that was never finished. Any of them sets `diverged_at_step` and makes every later step live. The check also runs at N itself, so if the agent's request at N already differs from the parent's, the override is skipped. A parent step that failed is replayed with its error, because that is what the agent saw.

**Why:** Divergence state lives only in `runs.diverged_at_step`, which is read and written under the same `FOR UPDATE` lock that assigns `idx`. That keeps both proxies in agreement with no extra table. Treating "parent has nothing usable here" as divergence means the engine never makes up a response. Running the check at N stops an edited response from answering a question the agent didn't ask. Leaving `latency_ms` NULL keeps replayed steps from adding fake time to run totals.

**Rejected:** Checking only the hash, which would replay a tool result to an LLM call that happened to hash the same. Also rejected: applying the override even after divergence. The agent is no longer where the parent was, so the edit would be out of context.

## A fork's override is either an edited response or an edited request

**Decision:** `fork_override` is `{ kind: 'response', response }` or `{ kind: 'request', request }`. At the fork step (after the agent's request has matched the parent's), a response override is saved as that step's finished result with `replayed = false`, and the proxy gets `{ mode: 'override', response }` and makes no call. A request override replaces the stored request and its hash, and the proxy gets `{ mode: 'override', request }`, sends that live, and finishes the step as usual. Changing the model or the prompt is a request override. A fork with no override replays up to the fork step, then goes live. `createRun` checks the shape and that `fork_step` and `fork_override` only come with a parent.

**Why:** Two kinds cover every edit the roadmap asks for (tool result, prompt, model) without a separate case for each. A tool result is just a response. The stored request is the one actually sent, so the timeline and later forks of this fork see the real call. `replayed = false` because the edited response came from the user, not from the parent run.

**Rejected:** Separate kinds like `model` or `prompt`. They'd each need their own merge logic, and they're all just an edited request. Also rejected: storing the agent's original request at the fork step, which would leave a row whose request doesn't match the call that produced its response.

## How the LLM proxy answers replayed and overridden steps

**Decision:** For `replay`, the proxy sends the parent's stored `response` as JSON and makes no upstream call. A step that succeeded comes back as 200. An upstream error status comes back with the same status and body: the status isn't stored, so it is read from our own `upstream HTTP <status>: ...` error text. A failure with no stored body (upstream unreachable, or a body that wasn't JSON) comes back as `502 { error }` with the recorded message. A response override is sent as 200 JSON. A request override is sent upstream as `JSON.stringify(request)` in place of the agent's bytes, and is then finished like any live step.

**Why:** The agent should get the same result it got the first time, and status codes matter because the OpenAI SDK throws on a 4xx/5xx. Reading the status from our own error text avoids a schema change for a rare case. The format is written in the same file (`describeError`), so the two can't drift apart unnoticed. Replayed bodies are equal JSON, not the same bytes: Postgres `jsonb` doesn't keep key order or whitespace. That's fine, because the SDK parses the body, and Rule 2 (byte-for-byte) applies to live record mode, not to answers Rewind serves itself.

**Rejected:** Adding a `status` column now. It's cleaner, but it's a migration plus changes to both recorders, for failed steps that a fork usually goes past anyway. If replaying failures turns out to matter, it can be added later. Also rejected: replaying every failure as a 502, which would turn a 404 the agent handled into a different error.

## The MCP proxy follows the server's mode, and fails closed only in forks

**Decision:** The MCP proxy handles the same modes as the LLM proxy. `replay` returns the parent's tool result (`isError` results included) and makes no call. A recorded protocol error is thrown again with the code read from its `MCP error <code>: ` text, so the agent gets the same code and message. A response override is returned with no call. A request override calls the tool with the edited `{ name, arguments }` and finishes the step. At startup the proxy asks `GET /api/runs/:id` whether the run has a parent. If it does, a tool step that can't be started becomes an error for the agent, and the tool isn't called. If the run isn't a fork, or the lookup itself fails, recording stays fail-open as before.

**Why:** In record mode, losing a step is better than breaking the agent. In a fork, the server may have meant to replay that step, and calling the tool live repeats its side effects (moving a file again, for example). The sample agent shows the error to the model, so the fork's next LLM request differs from the parent's and is flagged as a divergence, which is visible and honest. Asking the server keeps it the only source of truth about a run, and no agent has to pass a new environment variable through (the SDK's stdio transport drops unknown variables). If the lookup can't reach the server, the fork's LLM calls can't reach it either, so the run fails anyway.

**Rejected:** A `REWIND_FORK=1` variable set by the fork launcher. Every agent would have to forward it to its MCP servers, as the sample agent already does for `REWIND_RUN_ID`. Also rejected: failing closed in every run, which goes against Rule 2 for normal recording.

## The server launches forks, and a fork can run a setup command first

**Decision:** `POST /api/runs/:id/fork` checks the request, creates the fork run with the parent's `command` and `cwd`, answers `201` straight away, and launches the agent in the background (`server/src/launcher.js`). It uses the same no-shell `spawn` as `rewind run`, with `REWIND_RUN_ID`, `REWIND_BASE_URL` and `REWIND_SERVER_URL` set, and sets the run's status from the exit code. Only finished runs can be forked, and `fork_step` must be one of the parent's steps. Every check runs before a run is created. An optional `setup` argv runs first in the same `cwd`. If it fails, the run is marked `failed` and the agent never starts. The server learns its own URL from `REWIND_SERVER_URL` (default `http://localhost:<PORT>`).

**Why:** A fork is started from the web UI, so something besides the CLI has to launch the agent, and the server already owns the runs. Answering at once keeps the UI responsive while a CPU-only agent runs for minutes. Replayed tool steps don't run, so the agent starts live in whatever state the world is in now. `setup` lets the user reset it (for the sample agent, `["node", "examples/agent/seed.js"]`) without the server knowing anything about any particular agent. That's exactly right for a fork made before the first tool call that changes files. A later fork still starts from the reset state, not the state at the fork step, and that's documented as a limitation. The URL isn't taken from the request, because a request coming through Vite's dev proxy carries `:5173`, which doesn't forward the `/r` LLM route. `setup` isn't stored, since it's a launch option rather than part of the run's history.

**Rejected:** Re-running file-changing tools during replay so the sandbox matches the fork step. That breaks Rule 6 (no live calls before the fork step) and needs a list of which tools have side effects. Also rejected: making the user reset the sandbox by hand (easy to forget, and the fork then quietly misbehaves), and waiting for the agent to finish before answering.

## The fork editor: Monaco from its CDN, a JSON argv for setup, and setup on by default for the sample agent

**Decision:** "Fork from here" on a step opens an inline panel with two tabs, *Edit response* and *Edit request*. Each is a Monaco JSON editor pre-filled with the recorded JSON, and each keeps its own draft. The text is parsed as you type, and "Fork and run" stays disabled until it is a JSON object. The setup field takes a JSON argv array, and "Run setup first" starts checked when the run's command is the sample agent (`examples/agent/index.js`), pre-filled with `["node", "examples/agent/seed.js"]`. After the fork is created, the app opens its page, which polls while the run is recording. `@monaco-editor/react` loads Monaco itself from the jsdelivr CDN, its default.

**Why:** Monaco gives JSON highlighting, bracket matching and error marks for free, and the fork editor is where you edit large tool results and chat completions. Loading it from the CDN means no Vite worker setup and a small bundle. A JSON argv for setup matches how the server runs it (no shell), so there's no shell-style quoting to parse in the browser. Checking setup by default for the sample agent stops the demo from forking against a sandbox left in another run's final state, which would quietly give wrong results.

**Rejected:** Bundling `monaco-editor` locally. That works offline, but it needs worker imports and makes the bundle several MB bigger, and it can be switched later through `loader.config({ monaco })`. Also rejected: a plain command-line text box for setup (it would need splitting on spaces, which brings back quoting problems) and a modal dialog (the inline panel keeps the step's recorded data visible below the editor).

**Note:** `npm audit` reports two low-severity advisories for `dompurify`, which `monaco-editor` pins exactly. That local copy is only installed as a peer dependency. The browser loads Monaco from the CDN, so it never reaches the page.

## The branch graph uses a hand-written row-per-run layout, with fork details in the nodes

**Decision:** The run page shows a "Fork tree" graph (React Flow) whenever the run has a parent or forks. `web/src/tree.js` turns the flat `/tree` list into nodes and edges. A depth-first walk from the root gives each run its own row, and the fork depth sets the column, as in `git log --graph`. Each node shows the status, name, short id, "diverged at N" when it applies, and for a fork, "fork at step N · edited response/request". The current run is highlighted, and clicking a node opens that run. The graph is read-only (no dragging or selecting), and scroll-to-zoom is off so the page scrolls normally over it. It polls while any run in the tree is recording.

**Why:** Fork trees are small and shaped like trees, so about 15 lines of layout are enough, with no layout library to learn or explain. Putting the fork details in the node and not on the edge avoids sibling labels piling up where the edges leave the parent, which happened in the first version. A read-only graph matches what it's for: seeing where runs branched and moving between them.

**Rejected:** `dagre` or `elkjs` for automatic layout (a dependency for a problem a simple depth-first walk already solves), labels on the edges (they overlapped), and hiding React Flow's attribution (its maintainers ask that it stay unless you sponsor the project).

## The run diff lines up steps by idx, and labels each row from the recorded data

**Decision:** `/runs/:id/diff` shows a fork next to its parent, one row per `idx`. `web/src/diff.js` gives each row a kind, checked in this order: the fork step, the step where the run diverged, a replayed step, then for live steps "same request" or "new request" by comparing `request_hash`, and "parent only" / "fork only" once one run has ended. "Replayed" comes from the step's `replayed` flag, not from `idx < fork_step`. Clicking a row shows both responses side by side, plus both requests on rows where the requests differ. The run page links to the diff from a fork's "Fork of …" line. The web app now has `npm test` (Node's built-in runner, no new dependency) for this pure logic.

**Why:** A fork reuses its parent's step numbers by design, so the same `idx` really is the same point in the run, and lining up by idx is the honest comparison. Reading the `replayed` flag keeps the page right when a fork diverged before its fork step and went live early. Comparing hashes after the fork shows how far an edit spread: in fork 9aaa4c86, every step after the edited `list_files` result sent a new request, because each LLM request carries the conversation so far.

**Rejected:** An LCS-style match (like `diff`) that pairs steps by content. It could pair steps from different points in the run and hide where the fork changed things. It would also need a library or a bigger algorithm to explain. Also rejected: a text diff of the JSON inside each row. Showing both sides is enough for now and needs no dependency.

## The intel service reads Postgres through a read-only connection

**Decision:** `intel/db.py` opens every connection with `default_transaction_read_only=on`, so Postgres itself rejects INSERT, UPDATE and DELETE from the Python service. A test checks that an `UPDATE` raises `ReadOnlySqlTransaction`.

**Why:** Rule 3 says the Python service only reads, and any writes go through the Node API. Enforcing that in the database means the rule holds even if someone later writes a wrong query here. It's one connection option, with no extra setup.

**Rejected:** A separate Postgres role with only `SELECT` grants. It's stronger, but it needs a migration, a second password and a second `DATABASE_URL`, which is too much for a local dev setup. It's worth revisiting at deploy time (Phase 10).

## Loop detection reuses request_hash and ignores errored LLM steps

**Decision:** `intel/loops.py` reports two kinds of loop. A `tool_cycle` is one tool call, or a cycle of 2–3 calls, repeated at least 3 times back to back, comparing tool steps only. A `repeated_llm_request` is the exact same LLM request sent more than once. Calls are compared by the `request_hash` the Node server already stored, and LLM steps that errored don't count. It's served at `GET /runs/{id}/loops`.

**Why:** Two tool calls have the same hash exactly when they have the same name and arguments, so reusing it keeps one `hashRequest()` and avoids a Python copy of the canonical JSON that could drift. LLM steps are left out of cycle matching because each LLM request carries the growing conversation and never repeats, even when the agent is stuck. Errored LLM steps are skipped because of a real run: failed run e7cfcdd1 sent the same request 3 times, but those were the OpenAI SDK's automatic retries after upstream timeouts, not the agent looping. Errored tool calls do count, because the MCP proxy never retries, so a repeated failing call is the agent's own choice.

**Rejected:** Matching on the tool name only, which would flag a normal run moving several files with `move_file`. Also rejected: a general repeated-substring search, which is harder to explain and finds odd cycles of no use. Periods up to 3 cover the stuck patterns seen in agents (A A A, A B A B).

## A failure is an errored live step, or a failed run with no step error at the end

**Decision:** `intel/failures.py` turns runs into a flat list of failures. Every step with an `error` counts, unless it was `replayed`. A run with `status = failed` adds one more failure only when its last step has no error (it hit the step limit, crashed, or died mid-call). Each failure keeps the raw `message` for display and its `tool`, plus a `signature` for clustering: the message with UUIDs, file names and numbers replaced by `<id>`, `<file>`, `<n>`, and for tool errors the value after the last `: ` replaced by `<value>` (see the signature entry below). Tool errors are unwrapped from the `{"error": "..."}` JSON the MCP proxy stores. `GET /failures` returns the list.

**Why:** A fork copies its parent's responses, so a replayed error is the parent's failure. Counting it again would make a failure look more common each time someone forks the run. A failed run whose last step already errored is explained by that step, so it isn't counted twice. Normalising details means two runs hitting the same bug on different files produce nearly the same text, so the clusters group by kind of error, not by file.

**Rejected:** Counting only failed runs. In the real data, run 04c8166c succeeded but had a sandbox escape and an unknown-tool call, and those are the failures worth seeing.

## Failure patterns: HDBSCAN over unique signatures, and every failure lands in a pattern

**Decision:** `GET /failures/clusters` embeds each failure signature with `all-MiniLM-L6-v2` (local, CPU) and clusters the **unique** signatures with scikit-learn's `HDBSCAN(min_cluster_size=2, min_samples=1)`. Similar signatures become a `cluster` pattern. A signature HDBSCAN leaves out becomes a `single` pattern of its own. Each pattern has a label (its most common signature), a size, a run count, its signatures with counts, and its failures. Patterns are sorted by size. The results are computed on each request, with the model loaded once on first use and embeddings cached by signature. Nothing is stored.

**Why:** HDBSCAN needs no cluster count up front and can call a point noise, which suits failures where most kinds are unknown in advance. Clustering unique signatures came from trying it on the real data: three identical "Already exists: documents" failures sit at distance 0, which looks like infinite density, so HDBSCAN pulled the unrelated sandbox-escape and unknown-tool failures into their cluster. Without duplicates it separated them correctly (tested with 16 sample failures: already-exists, upstream LLM errors, sandbox escapes, and the unknown tools left as noise). The `single` patterns matter because the dev database has only 6 unique signatures, too few for HDBSCAN to find anything, and "timeout ×3" should still show up. Computing on demand keeps the service read-only (Rule 3). Storing the results would mean writing through the Node API, which isn't worth it at this size.

**Rejected:** K-means (it needs a cluster count and puts every failure in some cluster). Also rejected: `leaf` cluster selection, which gave the same merge on the small data, since duplicates were the real cause. Also rejected: filtering by HDBSCAN's membership `probabilities_`, which were 0 for most points next to the duplicates. And a cosine-distance threshold without HDBSCAN: simpler, but it's a magic number, and it doesn't use the library Phase 6 called for.

**Note:** `sentence-transformers` pulls in PyTorch (CPU). The first `/failures/clusters` call takes about 17 s to import torch and load the model; after that it's about 0.3 s. The model download (~90 MB) happens once, into the Hugging Face cache.

## Seeded failures, and signatures without the tool name

**Decision:** `examples/agent/seed-failures.js` (`npm run seed:failures`) records 10 scripted runs named `[seed] ...` through the normal API routes (create run, start/finish each step, set status). They use the real tool error texts: collisions, sandbox escapes, unknown tools, missing files, bad arguments, LLM timeouts, HTTP errors, a run stuck calling `list_files` until the step limit, and a run killed mid-call. It refuses to add a second set unless `--force` is passed. After seeing how they clustered, signatures changed: the tool name is no longer part of the signature (it's still on each failure), and for tool errors the text after the last `: ` becomes `<value>`.

**Why:** The dev database had 6 unique failure signatures, too few to cluster, and running the real agent on CPU until it fails is slow and not repeatable. Going through the API keeps Rule 3 (only the Node server writes) and records steps exactly as the proxies would. A seeded run's `command` is the real agent command, so forking one launches the actual agent, which diverges at once because the seeded requests are scripted. On the seeded data, signatures that started with `tool move_file:` clustered by tool: "Already exists", "Only files can be moved" and "Folder does not exist" landed together, and "Unknown tool: rename_file" was left out of the other unknown-tool errors. With the message alone, errors grouped by kind instead. Replacing the value after the last colon then made "Already exists, not overwriting: images / docs / music" one pattern (×8) instead of three, because the folder names had been pulling the embeddings apart. LLM errors keep their detail, since in "upstream HTTP 404: model not found" the part after the colon is the error. Final result: 39 failures in 9 patterns.

**Rejected:** Keeping the tool name at the end of the signature (it still split errors by tool). Also rejected: message-only without the `<value>` rule (it split "Already exists" three ways). The rule leans on the "Description: value" style these tools use, which is common but not universal. A tool whose message has its meaning after the colon will lose some detail, but it will still group with similar errors.

**Trade-off seen:** with fewer distinct signatures, HDBSCAN pairs some small groups loosely ("Not found ×4" with "Missing or invalid argument ×2"). The dashboard shows each signature's count inside a pattern, so that stays readable.

## The failures page and loop warning call the intel service through Vite, and stay optional

**Decision:** Vite proxies `/intel/*` to the Python service on :8000, with the prefix removed, the same way `/api` goes to the Node server. `/failures` lists the failure patterns largest first. Each row shows its size, its label, how many messages and runs it covers, and a bar drawn in CSS relative to the largest pattern. Clicking a row opens its messages with counts, and every failure links to its run and step (`/runs/:id?step=N`). The run page shows a "Possible loop" box with clickable step numbers when `/runs/:id/loops` finds one. That box shows nothing if the intel service is down, and it checks again when a recording run finishes. The intel service starts loading the embedding model in a background thread at startup, and a lock makes an early request wait for that load instead of starting a second one.

**Why:** Going through the Vite proxy keeps everything same-origin, with no CORS and no extra Node code. The run page already works without Python, and a missing optional service shouldn't break it. A bar per row says "how big compared to the biggest", which is all this view needs, so `recharts` isn't worth a new dependency yet. Loading the model at startup moves the ~17 s wait away from the first page visit.

**Rejected:** Having Node forward `/api/intel/*` (one origin for production, but an extra hop and more code; revisit at deploy time in Phase 10). Also rejected: a `recharts` bar chart (a new dependency for what CSS widths already show), and `functools.lru_cache` for the model, which doesn't make a second caller wait, so a request during startup would have loaded a second copy.

## Evals copy their run's command, carry an optional setup, and a result starts with passed NULL

**Decision:** An eval (`migrations/002_evals.sql`) copies `command` and `cwd` from the run it was made from, the way a fork does, and `source_run_id` is `ON DELETE SET NULL`. It also has a nullable `setup` argv column, not in the original schema, that runs before the agent in the same `cwd` (for the sample agent, `node examples/agent/seed.js`). `input_task` is only a label, since the task is already the last element of `command`. In `eval_results`, `passed` is NULL while the eval's run is going: the row is written when the server launches the run and filled in when the run exits and its assertions are checked. Results have no API route for writing; only the server writes them.

**Why:** An eval is a frozen test case, so it should keep working after its source run is deleted, which is why it keeps its own copy of the command and isn't deleted with the run. `setup` exists because the sample agent changes the files it works on: without reseeding, the second run of an eval would start from an already-sorted sandbox and test something different. Forks already take `setup` per request, but for an eval it belongs to the test case itself. Writing the result row at launch lets the evals page show a run in progress. A row left NULL after a server crash matches how a run stays `running` after one.

**Rejected:** Pointing at the source run instead of copying (deleting a run would break its evals). Also rejected: inserting the result only when the run finishes (simpler, but runs in progress would be invisible), and a results route the CLI posts to (a second writer for the same data).

## Migrations take an advisory lock

**Decision:** `migrate()` holds a Postgres advisory lock (`pg_advisory_lock(4000)`) on one connection while it reads `schema_migrations` and applies the pending files.

**Why:** `node --test` runs each test file in its own process, and each calls `migrate()` in `before()`. The first time a migration was pending (002), several processes applied it at once, and all but one failed on `CREATE TABLE evals`. With the lock, one process applies it and the others wait, then find it already applied. The same holds for two servers starting together.

**Rejected:** Running `npm run migrate` once before the tests (it hides the race instead of fixing it), and `CREATE TABLE IF NOT EXISTS` in migrations (a half-applied file would be skipped silently and the name check would still race).

## Eval assertions: six types in one table, validated strictly, checked by pure functions

**Decision:** `server/src/assertions.js` holds one entry per assertion type (`run_status`, `max_steps`, `must_call_tool`, `must_not_call_tool`, `max_tool_errors`, `final_output_contains`), each with its fields and a `check(run, steps, a)` that returns a failure message or null. `checkAssertions` returns `{ passed, failures: [{ index, assertion, message }] }`, which is what `eval_results.failures` stores. `assertionsError` rejects unknown types, missing or wrong-typed fields, and extra keys. `max_steps` counts Rewind steps (LLM and tool), not the agent's loop turns. `final_output_contains` ignores case and reads the last LLM step that finished. Failure messages name the step `idx` values involved ("called move_file at steps 3, 5").

**Why:** Rule 8: an eval should give the same verdict for the same run every time, so checks are plain code over recorded data, not an LLM's judgement. Keeping them pure (no DB) makes them fast to test and lets the same function check a run in step 4 and preview a draft later. Rejecting extra keys means `{ type: "must_call_tool", tool: "x", args: {...} }` fails with a 400 instead of quietly ignoring `args`, which would make the test weaker than its author thinks. Ignoring case avoids failing a regression test over "Sorted" vs "sorted".

**Rejected:** An LLM judge for the final answer (not deterministic, and not free on CPU). Also rejected: counting agent turns for `max_steps` (Rewind doesn't know the agent's loop; it only sees steps), and `must_not_loop` for now: it needs the Python loop detector, and calling the intel service from the checker would make a pure check depend on another service.

## Eval drafts are proposed in Python from simple rules, never saved there

**Decision:** `GET /runs/{id}/eval-draft` (`intel/drafts.py`) returns `{ run_id, input_task, suggestions: [{ assertion, reason }] }` for a finished run. A run that succeeded gets a "keep this working" test: `run_status: success`, `max_steps` at 1.5× its step count, `must_call_tool` for each tool it used without an error, and `max_tool_errors` at its own error count. A run that failed gets a regression test for its bug: `run_status: success`, `max_tool_errors: 0` if tools failed, `must_not_call_tool` for tools it called that the LLM was never offered, and `max_steps` at its step count − 1 only when the Phase 6 loop detector finds a loop. `final_output_contains` is never proposed. `input_task` is the command's last argument, falling back to the run name. The web UI shows the reasons, lets the user edit, and saves through `POST /api/evals`.

**Why:** Splitting it this way keeps Rule 3: Python only reads and proposes, and Node validates and writes. Drafting in Python lets it reuse `detect_loops`, which gives most of what `must_not_loop` would have given without the Node checker calling another service. The failed-run eval is meant to be red until the bug is fixed, the way a regression test is written before the fix. 1.5× headroom is there because the model isn't deterministic, so an exact step count would make the test flaky. A tool counts as "unknown" only when it's missing from the `tools` list in the run's LLM requests. If no request lists tools (the seeded runs don't), nothing is flagged, rather than guessing. Picking a phrase for `final_output_contains` out of free LLM text would be a guess, so the user writes that one.

**Rejected:** Asking an LLM to write the assertions (not deterministic, slow on CPU, and the rules are easy to explain). Also rejected: saving drafts from Python (a second writer), and requiring every tool the source run called, including ones that only failed (a fixed agent may rightly never call them).

## The server runs evals and checks them; `rewind eval` only starts runs and waits

**Decision:** `POST /api/evals/:id/runs` creates the run and its `eval_results` row (`passed` NULL) in one transaction, answers at once, launches the agent with the existing `launchRun` (after the eval's `setup`), and then checks the assertions and saves the verdict. An eval run is a fresh live run, not a fork: it has no parent and replays nothing. `rewind eval <id>... | --all` starts each eval in turn, polls `GET /api/evals/:id` every 2 s until that result has a verdict, prints PASS/FAIL with the failure messages, and exits 0 only if every eval passed. It stops waiting after 30 minutes per eval. `callApi` and `log` moved to `src/apiClient.js` so `cli.js` and `evalCommand.js` share them without importing each other.

**Why:** The server launching and checking keeps one writer for results (no public "write result" route), and reuses the fork launcher unchanged. A live run is the point of an eval: it asks what the agent does now with the same task, which replaying recorded responses can't answer. Running evals one at a time matters because evals of the sample agent share its sandbox, and each one's `setup` reseeds it. The exit code lets `rewind eval --all` gate a commit or a CI job. The timeout exists because a server restart mid-run leaves the result NULL forever.

**Rejected:** The CLI spawning the agent itself, like `rewind run` (its output would show locally, but the CLI would then have to write results through a new route). Also rejected: a blocking request that answers only when the run finishes (a 3-minute HTTP request, and the web UI also needs to start evals without waiting), and stopping concurrent evals on the server (not needed while `--all` runs them in order).

**Trade-off seen:** the 2 s poll adds a few seconds to the server tests (about 10 s instead of 2 s), which wasn't worth a configurable interval.

## The eval editor is a form of one-field rows, and works without the intel service

**Decision:** "Create eval" on a finished run's page fetches the Python draft and shows one row per suggestion: a checkbox, the type, one input for its single field (a select for `run_status`), and the draft's reason. The user can untick rows, edit values, add rows of any type (e.g. `final_output_contains`, which the draft never proposes), set the task label, and set `setup` (pre-filled with the sample agent's seed script, shared with the fork editor through `web/src/setup.js`). Number fields are sent as integers only when they're whole numbers; anything else is sent as typed so the server's 400 message is shown. If the intel service is down, the editor says so and starts with one `run_status: success` row. `/evals` lists evals with their latest verdict and pass counts; `/evals/:id` shows the assertions in plain words, a "Run eval" button (disabled while a run of that eval is in progress), and every result with its failure messages, polling while a result is unchecked.

**Why:** Every assertion type has exactly one field, so a row per assertion is simpler to use than a JSON editor and needs no schema code beyond a small `FIELDS` table. Keeping the server as the only validator means the rules live in one place (`assertions.js`). The form mounts once with the draft's rows, so a background refetch never overwrites edits. The run page has worked without Python since Phase 6, and creating an eval shouldn't be the exception. The panel remembers which run it's open for, because the run page stays mounted when moving between runs.

**Rejected:** A Monaco JSON editor for the assertions (flexible, but easy to get wrong and hides the reasons), and repeating the server's validation in the browser (two copies of the rules to keep in sync).
