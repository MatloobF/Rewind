-- Regression evals made from recorded runs, and the result of each time one runs.

CREATE TABLE evals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The run the eval was made from. SET NULL, not CASCADE: the eval keeps its
  -- own copy of command and cwd, so it still works after that run is deleted.
  source_run_id UUID REFERENCES runs (id) ON DELETE SET NULL,
  -- A label for the UI. The task the agent gets is already in command.
  input_task    TEXT NOT NULL,
  -- argv copied from the source run, launched with spawn() and no shell
  command       JSONB NOT NULL,
  cwd           TEXT NOT NULL,
  -- Optional argv run first in cwd, e.g. a script that reseeds the sandbox,
  -- so every run of the eval starts from the same files.
  setup         JSONB,
  -- Structured checks, e.g. [{ "type": "max_steps", "max": 20 }]
  assertions    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(command) = 'array'),
  CHECK (setup IS NULL OR jsonb_typeof(setup) = 'array'),
  CHECK (jsonb_typeof(assertions) = 'array')
);

CREATE TABLE eval_results (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eval_id    UUID NOT NULL REFERENCES evals (id) ON DELETE CASCADE,
  run_id     UUID NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  -- NULL while the run is going; set when it exits and the assertions are checked.
  passed     BOOLEAN,
  -- The assertions that failed and why, once checked.
  failures   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX eval_results_eval_id_created_at_idx ON eval_results (eval_id, created_at);
