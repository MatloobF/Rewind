-- Runs and their steps. Forks point at their parent run, forming a tree.

CREATE TABLE runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT,
  -- argv array, re-launched with spawn(argv[0], argv.slice(1), { cwd }), never a shell
  command          JSONB NOT NULL,
  cwd              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'success', 'failed')),
  parent_run_id    UUID REFERENCES runs (id),
  fork_step        INT,
  fork_override    JSONB,
  -- Separate from status: a diverged run can still succeed or fail.
  diverged_at_step INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(command) = 'array')
);

CREATE INDEX runs_parent_run_id_idx ON runs (parent_run_id);

CREATE TABLE steps (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  -- 0-based, shared by LLM and tool steps. Assigned only by the server.
  idx          INT NOT NULL CHECK (idx >= 0),
  type         TEXT NOT NULL CHECK (type IN ('llm', 'tool')),
  request      JSONB NOT NULL,
  -- NULL while the live call is in progress; left NULL if the agent died mid-call.
  response     JSONB,
  request_hash TEXT NOT NULL,
  latency_ms   INT,
  tokens_in    INT,
  tokens_out   INT,
  error        TEXT,
  replayed     BOOLEAN NOT NULL DEFAULT false,
  -- Also serves as the (run_id, idx) index.
  UNIQUE (run_id, idx)
);
