import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { fetchEvals } from '../api.js';
import VerdictBadge from '../components/VerdictBadge.jsx';
import { formatDate, shortId } from '../format.js';

export default function EvalList() {
  const { data: evals, error, isPending } = useQuery({
    queryKey: ['evals'],
    queryFn: fetchEvals,
    // Poll only while some eval's latest run hasn't been checked yet.
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.latest_result && e.latest_result.passed === null) ? 2000 : false,
  });

  if (isPending) return <p className="text-zinc-400">Loading evals...</p>;
  if (error) return <p className="text-rose-300">Could not load evals: {error.message}</p>;

  return (
    <div>
      <h1 className="text-xl font-semibold">Evals</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Regression tests made from recorded runs. Each run of an eval re-runs the command live and checks its assertions.
        Run them all with <code className="text-zinc-200">rewind eval --all</code>.
      </p>

      {evals.length === 0 ? (
        <p className="mt-6 text-zinc-400">No evals yet. Open a finished run and click &quot;Create eval&quot;.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="py-2 pr-4 font-medium">Eval</th>
                <th className="py-2 pr-4 font-medium">Latest</th>
                <th className="py-2 pr-4 text-right font-medium" title="Passed / checked runs">Passed</th>
                <th className="py-2 pr-4 text-right font-medium">Assertions</th>
                <th className="py-2 pr-4 font-medium">From run</th>
                <th className="py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {evals.map((ev) => (
                <tr key={ev.id} className="border-b border-zinc-900 hover:bg-zinc-900/60">
                  <td className="py-2 pr-4">
                    <Link to={`/evals/${ev.id}`} className="font-medium text-zinc-100 hover:underline">
                      {ev.input_task}
                    </Link>
                    <div className="font-mono text-xs text-zinc-500">{shortId(ev.id)}</div>
                  </td>
                  <td className="py-2 pr-4">
                    <VerdictBadge result={ev.latest_result} />
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {ev.checked_count === 0 ? '-' : `${ev.passed_count} / ${ev.checked_count}`}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{ev.assertions.length}</td>
                  <td className="py-2 pr-4">
                    {ev.source_run_id ? (
                      <Link to={`/runs/${ev.source_run_id}`} className="font-mono text-xs text-zinc-400 hover:underline">
                        {shortId(ev.source_run_id)}
                      </Link>
                    ) : (
                      <span className="text-xs text-zinc-600">deleted</span>
                    )}
                  </td>
                  <td className="py-2 text-zinc-400">{formatDate(ev.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
