import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { fetchRun } from '../api.js';
import BranchGraph from '../components/BranchGraph.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import StepDetail from '../components/StepDetail.jsx';
import StepList from '../components/StepList.jsx';
import { formatCommand, formatDate, formatMs, formatNumber, shortId } from '../format.js';

export default function RunPage() {
  const { id } = useParams();
  // The selected step lives in the URL (?step=2) so it can be linked.
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: run, error, isPending } = useQuery({
    queryKey: ['run', id],
    queryFn: () => fetchRun(id),
    // Same as the run list: poll only while the run is recording.
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });

  if (isPending) return <p className="text-zinc-400">Loading run...</p>;
  if (error) return <p className="text-rose-300">Could not load run: {error.message}</p>;

  const { steps } = run;
  const requested = Number(searchParams.get('step'));
  const selected = steps.find((s) => s.idx === requested) ?? steps[0];
  const sum = (field) => steps.reduce((total, s) => total + (s[field] ?? 0), 0);

  return (
    <div>
      <Link to="/" className="text-sm text-zinc-400 hover:underline">
        &larr; All runs
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{run.name ?? shortId(run.id)}</h1>
        <StatusBadge status={run.status} />
        {run.diverged_at_step != null && (
          <span className="text-sm text-amber-300">diverged at step {run.diverged_at_step}</span>
        )}
      </div>
      {run.parent_run_id && (
        <p className="mt-1 text-sm text-violet-300">
          Fork of{' '}
          <Link to={`/runs/${run.parent_run_id}`} className="underline">
            {shortId(run.parent_run_id)}
          </Link>{' '}
          at step {run.fork_step} ·{' '}
          <Link to={`/runs/${run.id}/diff`} className="underline">
            Compare with parent &rarr;
          </Link>
        </p>
      )}
      <p className="mt-1 font-mono text-xs text-zinc-500">
        {formatCommand(run.command)} <span className="text-zinc-600">in {run.cwd}</span>
      </p>
      <p className="mt-1 text-sm text-zinc-400">
        {formatDate(run.created_at)} · {steps.length} steps · {formatNumber(sum('tokens_in'))} in /{' '}
        {formatNumber(sum('tokens_out'))} out · {formatMs(sum('latency_ms'))} call time
      </p>

      <BranchGraph runId={run.id} />

      {steps.length === 0 ? (
        <p className="mt-6 text-zinc-400">No steps recorded yet.</p>
      ) : (
        <div className="mt-6 grid gap-6 md:grid-cols-[18rem_1fr]">
          <aside className="md:sticky md:top-4 md:max-h-[calc(100vh-2rem)] md:self-start md:overflow-y-auto">
            <StepList
              steps={steps}
              selectedIdx={selected.idx}
              onSelect={(idx) => setSearchParams({ step: String(idx) }, { replace: true })}
            />
          </aside>
          <div className="min-w-0">
            {/* key resets the "show all messages" toggle and the fork editor when the step changes */}
            <StepDetail key={selected.idx} step={selected} steps={steps} run={run} />
          </div>
        </div>
      )}
    </div>
  );
}
