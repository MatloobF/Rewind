import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { createEval, fetchEvalDraft } from '../api.js';
import { ASSERTION_TYPES, FIELDS, RUN_STATUSES, assertionsFromRows, newRow, rowsFromDraft } from '../evals.js';
import { SAMPLE_SETUP, isSampleAgent, parseSetup } from '../setup.js';

// Without the intel service there's no draft, so start with the one check
// every eval of a finished run can use.
const FALLBACK_DRAFT = {
  suggestions: [{ assertion: { type: 'run_status', status: 'success' }, reason: 'default (no draft available)' }],
};

// "Create eval" panel on the run page: fetches a draft from the intel
// service, then lets the user edit and save it. Nothing is saved until
// "Save eval"; the Node API validates and stores it.
export default function EvalEditor({ run, onCancel }) {
  const { data: draft, error, isPending } = useQuery({
    queryKey: ['eval-draft', run.id],
    queryFn: () => fetchEvalDraft(run.id),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (isPending) {
    return <Panel>Drafting assertions from this run...</Panel>;
  }
  // The form mounts once with its starting rows, so a refetch never
  // overwrites the user's edits.
  return (
    <EvalForm
      run={run}
      draft={draft ?? FALLBACK_DRAFT}
      draftError={error?.message}
      onCancel={onCancel}
    />
  );
}

function Panel({ children }) {
  return <div className="mt-4 rounded border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-zinc-300">{children}</div>;
}

function EvalForm({ run, draft, draftError, onCancel }) {
  const [rows, setRows] = useState(() => rowsFromDraft(draft));
  const [task, setTask] = useState(draft.input_task ?? run.command.at(-1) ?? '');
  const [useSetup, setUseSetup] = useState(isSampleAgent(run.command));
  const [setupText, setSetupText] = useState(JSON.stringify(SAMPLE_SETUP));
  const [addType, setAddType] = useState('final_output_contains');

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: createEval,
    onSuccess: (ev) => {
      queryClient.invalidateQueries({ queryKey: ['evals'] });
      navigate(`/evals/${ev.id}`);
    },
  });

  const assertions = assertionsFromRows(rows);
  const setup = useSetup ? parseSetup(setupText) : { value: null };
  const problem =
    setup.error ?? (assertions.length === 0 ? 'Tick at least one assertion.' : null) ?? (task.trim() ? null : 'The task is empty.');

  const updateRow = (id, change) => setRows(rows.map((r) => (r.id === id ? { ...r, ...change } : r)));

  function submit() {
    save.mutate({
      source_run_id: run.id,
      input_task: task.trim(),
      assertions,
      setup: setup.value ?? undefined,
    });
  }

  return (
    <div className="mt-4 rounded border border-emerald-500/30 bg-emerald-500/5 p-4">
      <h3 className="font-semibold text-emerald-200">Create eval from this run</h3>
      <p className="mt-1 text-sm text-zinc-400">
        An eval re-runs this run&apos;s command live and checks the assertions you tick below.{' '}
        {run.status === 'success'
          ? 'This run succeeded, so the draft checks it keeps working.'
          : 'This run failed, so the draft is a regression test: it fails until the bug is fixed.'}
      </p>
      {draftError && (
        <p className="mt-2 text-sm text-amber-300">
          No draft from the intel service ({draftError}), so this starts with one default check.
        </p>
      )}

      <label className="mt-3 block text-sm text-zinc-300">
        Task <span className="text-zinc-500">(a label; the agent gets the run&apos;s command)</span>
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        />
      </label>

      <ul className="mt-4 space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <input
              type="checkbox"
              checked={r.include}
              onChange={(e) => updateRow(r.id, { include: e.target.checked })}
              aria-label={`include ${r.type}`}
            />
            <span className={`w-44 font-mono text-xs ${r.include ? 'text-zinc-200' : 'text-zinc-500'}`}>{r.type}</span>
            <FieldInput row={r} onChange={(value) => updateRow(r.id, { value })} />
            {r.added ? (
              <button
                type="button"
                onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                className="text-xs text-zinc-500 hover:text-rose-300"
              >
                remove
              </button>
            ) : (
              <span className="text-xs text-zinc-500">{r.reason}</span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <select
          value={addType}
          onChange={(e) => setAddType(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs"
        >
          {ASSERTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setRows([...rows, newRow(addType)])}
          className="rounded px-3 py-1 text-zinc-300 hover:bg-zinc-800"
        >
          + Add assertion
        </button>
      </div>

      <div className="mt-4 text-sm text-zinc-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={useSetup} onChange={(e) => setUseSetup(e.target.checked)} />
          Run setup before each run <span className="text-zinc-500">(argv, no shell; resets the files the agent works on)</span>
        </label>
        <input
          value={setupText}
          onChange={(e) => setSetupText(e.target.value)}
          disabled={!useSetup}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs disabled:opacity-40"
        />
      </div>

      {(problem || save.error) && (
        <p className="mt-3 text-sm text-rose-300">{problem ?? `Could not save: ${save.error.message}`}</p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={Boolean(problem) || save.isPending}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {save.isPending ? 'Saving...' : 'Save eval'}
        </button>
        <button type="button" onClick={onCancel} className="rounded px-4 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

// The one input each assertion type has.
function FieldInput({ row, onChange }) {
  const { kind } = FIELDS[row.type];
  const className = 'rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-sm disabled:opacity-40';
  if (kind === 'status') {
    return (
      <select value={row.value} onChange={(e) => onChange(e.target.value)} disabled={!row.include} className={className}>
        {RUN_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      value={row.value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!row.include}
      inputMode={kind === 'int' ? 'numeric' : undefined}
      placeholder={kind === 'int' ? 'number' : FIELDS[row.type].name}
      className={`${className} ${kind === 'int' ? 'w-20' : 'w-48'}`}
    />
  );
}
