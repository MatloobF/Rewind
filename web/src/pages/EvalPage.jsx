import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { fetchEval, runEval } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import VerdictBadge from '../components/VerdictBadge.jsx';
import { describeAssertion } from '../evals.js';
import { formatCommand, formatDate, shortId } from '../format.js';

export default function EvalPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();

  const { data: ev, error, isPending } = useQuery({
    queryKey: ['eval', id],
    queryFn: () => fetchEval(id),
    // Poll while a run of this eval is still going or not yet checked.
    refetchInterval: (query) => (query.state.data?.results.some((r) => r.passed === null) ? 2000 : false),
  });

  const run = useMutation({
    mutationFn: () => runEval(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['eval', id] });
      queryClient.invalidateQueries({ queryKey: ['evals'] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  if (isPending) return <p className="text-zinc-400">Loading eval...</p>;
  if (error) return <p className="text-rose-300">Could not load eval: {error.message}</p>;

  const inProgress = ev.results.some((r) => r.passed === null);
  const checked = ev.results.filter((r) => r.passed !== null);
  const passedCount = checked.filter((r) => r.passed).length;

  return (
    <div>
      <Link to="/evals" className="text-sm text-zinc-400 hover:underline">
        &larr; All evals
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{ev.input_task}</h1>
        <VerdictBadge result={ev.results[0] ?? null} />
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={inProgress || run.isPending}
          title={inProgress ? 'Wait for the current run to be checked' : 'Run the command live and check the assertions'}
          className="ml-auto rounded bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          {run.isPending ? 'Starting...' : 'Run eval'}
        </button>
      </div>
      {run.error && <p className="mt-2 text-sm text-rose-300">Could not start: {run.error.message}</p>}

      <p className="mt-1 font-mono text-xs text-zinc-500">
        {formatCommand(ev.command)} <span className="text-zinc-600">in {ev.cwd}</span>
      </p>
      <p className="mt-1 font-mono text-xs text-zinc-500">
        {ev.setup ? (
          <>setup: {formatCommand(ev.setup)}</>
        ) : (
          <span className="text-zinc-600">no setup: each run starts with the files as they are</span>
        )}
      </p>
      <p className="mt-1 text-sm text-zinc-400">
        Created {formatDate(ev.created_at)} from run{' '}
        {ev.source_run_id ? (
          <Link to={`/runs/${ev.source_run_id}`} className="underline">
            {shortId(ev.source_run_id)}
          </Link>
        ) : (
          '(deleted)'
        )}
        {checked.length > 0 && ` · passed ${passedCount} of ${checked.length} runs`}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        Evals that share files (like the sample agent&apos;s sandbox) should run one at a time.
      </p>

      <h2 className="mt-6 text-sm font-semibold uppercase text-zinc-500">Assertions</h2>
      <ul className="mt-2 list-inside list-disc text-sm text-zinc-200">
        {ev.assertions.map((a, i) => (
          <li key={i}>
            {describeAssertion(a)}
          </li>
        ))}
      </ul>

      <h2 className="mt-6 text-sm font-semibold uppercase text-zinc-500">Results</h2>
      {ev.results.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-400">
          Not run yet. Click &quot;Run eval&quot;, or run <code className="text-zinc-200">rewind eval {ev.id}</code>.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {ev.results.map((r) => (
            <li key={r.id} className="rounded border border-zinc-800 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <VerdictBadge result={r} />
                <Link to={`/runs/${r.run_id}`} className="font-mono text-xs text-zinc-300 hover:underline">
                  run {shortId(r.run_id)}
                </Link>
                <StatusBadge status={r.run_status} />
                <span className="ml-auto text-zinc-400">{formatDate(r.created_at)}</span>
              </div>
              {r.failures?.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-sm text-rose-200">
                  {r.failures.map((f) => (
                    <li key={f.index}>
                      <span className="text-zinc-500">{describeAssertion(f.assertion)}:</span> {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
