import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import Editor from '@monaco-editor/react';
import { forkRun } from '../api.js';
import { SAMPLE_SETUP, isSampleAgent, parseSetup } from '../setup.js';

// What the user can edit at the fork step (see fork_override on the server):
// the result the agent gets back, or the request that is sent live instead.
const KINDS = {
  response: { label: 'Edit response', hint: 'The agent gets this result. Nothing is called at this step.' },
  request: { label: 'Edit request', hint: 'This request is sent live instead (e.g. change the model, prompt or tool arguments).' },
};

const pretty = (value) => JSON.stringify(value ?? {}, null, 2);

// Parses editor text into the object the API needs, or explains what's wrong.
function parseObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `The ${label} must be a JSON object.` };
  }
  return { value };
}

export default function ForkEditor({ run, step, onCancel }) {
  const [kind, setKind] = useState('response');
  // One draft per kind, so switching tabs doesn't lose edits.
  const [drafts, setDrafts] = useState({ response: pretty(step.response), request: pretty(step.request) });
  const [name, setName] = useState('');
  const [useSetup, setUseSetup] = useState(isSampleAgent(run.command));
  const [setupText, setSetupText] = useState(JSON.stringify(SAMPLE_SETUP));

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fork = useMutation({
    mutationFn: (body) => forkRun(run.id, body),
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${newRun.id}`);
    },
  });

  const edited = parseObject(drafts[kind], kind);
  const setup = useSetup ? parseSetup(setupText) : { value: null };
  const problem = edited.error ?? setup.error;

  function submit() {
    fork.mutate({
      fork_step: step.idx,
      fork_override: { kind, [kind]: edited.value },
      name: name.trim() || undefined,
      setup: setup.value ?? undefined,
    });
  }

  return (
    <div className="mt-4 rounded border border-violet-500/30 bg-violet-500/5 p-4">
      <h3 className="font-semibold text-violet-200">Fork at step {step.idx}</h3>
      <p className="mt-1 text-sm text-zinc-400">
        {replayedText(step.idx)}
        step {step.idx} gets your edit, and after that the agent runs live.
      </p>

      <div className="mt-3 flex gap-1">
        {Object.entries(KINDS).map(([key, { label }]) => (
          <button
            key={key}
            type="button"
            onClick={() => setKind(key)}
            className={`rounded px-3 py-1 text-sm ${kind === key ? 'bg-violet-500/30 text-violet-100' : 'text-zinc-400 hover:bg-zinc-800'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">{KINDS[kind].hint}</p>

      <div className="mt-2 overflow-hidden rounded border border-zinc-700">
        <Editor
          height="22rem"
          language="json"
          theme="vs-dark"
          path={`step-${step.idx}-${kind}.json`}
          value={drafts[kind]}
          onChange={(text) => setDrafts({ ...drafts, [kind]: text ?? '' })}
          options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, tabSize: 2 }}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-zinc-300">
          Name <span className="text-zinc-500">(optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${run.name ?? 'run'} (fork at step ${step.idx})`}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          />
        </label>
        <div className="text-sm text-zinc-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={useSetup} onChange={(e) => setUseSetup(e.target.checked)} />
            Run setup first <span className="text-zinc-500">(argv, no shell)</span>
          </label>
          <input
            value={setupText}
            onChange={(e) => setSetupText(e.target.value)}
            disabled={!useSetup}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs disabled:opacity-40"
          />
        </div>
      </div>

      {(problem || fork.error) && (
        <p className="mt-3 text-sm text-rose-300">{problem ?? `Could not fork: ${fork.error.message}`}</p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={Boolean(problem) || fork.isPending}
          className="rounded bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {fork.isPending ? 'Starting fork...' : 'Fork and run'}
        </button>
        <button type="button" onClick={onCancel} className="rounded px-4 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

// "Steps 0–3 are replayed from this run, " (nothing when forking at step 0).
function replayedText(forkStep) {
  if (forkStep === 0) return '';
  if (forkStep === 1) return 'Step 0 is replayed from this run, ';
  return `Steps 0–${forkStep - 1} are replayed from this run, `;
}

