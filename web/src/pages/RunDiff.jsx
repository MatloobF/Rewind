import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { fetchRun } from '../api.js';
import JsonView from '../components/JsonView.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { alignSteps, diffSummary } from '../diff.js';
import { shortId } from '../format.js';
import { stepState, stepSummary } from '../steps.js';

// Label and colors for each row kind (see diff.js).
const KIND = {
  replayed: { label: 'replayed', border: 'border-violet-500/60', text: 'text-violet-300' },
  override: { label: 'fork step', border: 'border-fuchsia-400', text: 'text-fuchsia-300' },
  diverged: { label: 'diverged', border: 'border-amber-400', text: 'text-amber-300' },
  'same-request': { label: 'live · same request', border: 'border-zinc-700', text: 'text-zinc-400' },
  'different-request': { label: 'live · new request', border: 'border-sky-500/60', text: 'text-sky-300' },
  'parent-only': { label: 'parent only', border: 'border-zinc-800', text: 'text-zinc-500' },
  'fork-only': { label: 'fork only', border: 'border-zinc-800', text: 'text-zinc-500' },
};

const STATE_DOT = {
  done: 'bg-emerald-400',
  error: 'bg-rose-400',
  pending: 'bg-zinc-500',
};

// Rows where the requests differ show them too; elsewhere only responses.
const SHOW_REQUESTS = new Set(['override', 'diverged', 'different-request']);

function StepCell({ step }) {
  if (!step) return <div className="text-sm text-zinc-600">—</div>;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[stepState(step)]}`} />
        <span className="font-semibold uppercase text-zinc-300">{step.type}</span>
      </div>
      <div className="mt-1 truncate text-sm text-zinc-300">{stepSummary(step)}</div>
    </div>
  );
}

// Request or response JSON for one side of an expanded row, with a link to
// the step on its run page.
function StepJson({ step, runId, field }) {
  if (!step) return <div />;
  return (
    <div className="min-w-0">
      <Link to={`/runs/${runId}?step=${step.idx}`} className="text-xs text-zinc-400 hover:underline">
        open step #{step.idx} &rarr;
      </Link>
      <div className="mt-1">
        <JsonView value={step[field] ?? step.error ?? null} />
      </div>
    </div>
  );
}

function DiffRow({ row, parentId, forkId }) {
  const [open, setOpen] = useState(false);
  const kind = KIND[row.kind];
  return (
    <li className={`border-l-4 ${kind.border}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="grid w-full grid-cols-[4rem_1fr_1fr] gap-4 px-3 py-2 text-left hover:bg-zinc-900"
      >
        <div>
          <div className="font-mono text-xs text-zinc-500">#{row.idx}</div>
          <div className={`mt-1 text-xs ${kind.text}`}>{kind.label}</div>
        </div>
        <StepCell step={row.parent} />
        <StepCell step={row.fork} />
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-4 pl-[5.75rem]">
          {SHOW_REQUESTS.has(row.kind) && (
            <div className="grid grid-cols-2 gap-4">
              <h4 className="col-span-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Request</h4>
              <StepJson step={row.parent} runId={parentId} field="request" />
              <StepJson step={row.fork} runId={forkId} field="request" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <h4 className="col-span-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Response</h4>
            <StepJson step={row.parent} runId={parentId} field="response" />
            <StepJson step={row.fork} runId={forkId} field="response" />
          </div>
        </div>
      )}
    </li>
  );
}

function RunHeading({ label, run }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <Link to={`/runs/${run.id}`} className="truncate font-medium hover:underline">
          {run.name ?? shortId(run.id)}
        </Link>
        <StatusBadge status={run.status} />
      </div>
      <div className="mt-0.5 text-xs text-zinc-500">
        <span className="font-mono">{shortId(run.id)}</span> · {run.steps.length} steps
      </div>
    </div>
  );
}

// A fork next to its parent, one row per idx.
export default function RunDiff() {
  const { id } = useParams();
  const forkQuery = useQuery({
    queryKey: ['run', id],
    queryFn: () => fetchRun(id),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });
  const parentId = forkQuery.data?.parent_run_id;
  const parentQuery = useQuery({
    queryKey: ['run', parentId],
    queryFn: () => fetchRun(parentId),
    enabled: Boolean(parentId),
  });

  const back = (
    <Link to={`/runs/${id}`} className="text-sm text-zinc-400 hover:underline">
      &larr; Back to run
    </Link>
  );
  if (forkQuery.isPending) return <p className="text-zinc-400">Loading run...</p>;
  if (forkQuery.error) return <p className="text-rose-300">Could not load run: {forkQuery.error.message}</p>;
  const fork = forkQuery.data;
  if (!fork.parent_run_id) return <div>{back}<p className="mt-3 text-zinc-400">This run is not a fork, so there is nothing to compare.</p></div>;
  if (parentQuery.isPending) return <p className="text-zinc-400">Loading parent run...</p>;
  if (parentQuery.error) return <p className="text-rose-300">Could not load parent run: {parentQuery.error.message}</p>;
  const parent = parentQuery.data;

  const rows = alignSteps(parent, fork);
  const summary = diffSummary(rows, fork);

  return (
    <div>
      {back}
      <h1 className="mt-3 text-xl font-semibold">Fork vs. parent</h1>
      <p className="mt-1 text-sm text-zinc-400">
        {summary.replayed} replayed · {summary.edit ? `edited ${summary.edit}` : 'no edit'} at step {summary.forkStep} ·{' '}
        {summary.divergedAt == null ? (
          'never diverged'
        ) : (
          <span className="text-amber-300">diverged at step {summary.divergedAt}</span>
        )}
      </p>

      <div className="mt-6 grid grid-cols-[4rem_1fr_1fr] gap-4 border-b border-zinc-800 px-4 pb-3">
        <div />
        <RunHeading label="Parent" run={parent} />
        <RunHeading label="Fork" run={fork} />
      </div>
      <ol className="mt-2 space-y-1">
        {rows.map((row) => (
          <DiffRow key={row.idx} row={row} parentId={parent.id} forkId={fork.id} />
        ))}
      </ol>
      {rows.length === 0 && <p className="mt-4 text-zinc-400">Neither run has recorded any steps yet.</p>}
    </div>
  );
}
