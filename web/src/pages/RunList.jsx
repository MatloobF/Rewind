import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { fetchRuns } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatCommand, formatDate, formatMs, formatNumber, shortId } from '../format.js';

export default function RunList() {
  const { data: runs, error, isPending } = useQuery({
    queryKey: ['runs'],
    queryFn: fetchRuns,
    // Poll only while some run is still recording, so new steps and the
    // final status appear without a reload. Idle lists don't poll.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 2000 : false,
  });

  if (isPending) return <p className="text-zinc-400">Loading runs...</p>;
  if (error) return <p className="text-rose-300">Could not load runs: {error.message}</p>;
  if (runs.length === 0) {
    return (
      <p className="text-zinc-400">
        No runs yet. Record one with{' '}
        <code className="text-zinc-200">rewind run --name "test" -- node examples/agent/index.js "sort the files"</code>
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-zinc-500">
          <tr className="border-b border-zinc-800">
            <th className="py-2 pr-4 font-medium">Run</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 text-right font-medium">Steps</th>
            <th className="py-2 pr-4 text-right font-medium">Tokens in / out</th>
            <th className="py-2 pr-4 text-right font-medium" title="Sum of step latencies">Call time</th>
            <th className="py-2 font-medium">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b border-zinc-900 hover:bg-zinc-900/60">
              <td className="py-2 pr-4">
                <Link to={`/runs/${run.id}`} className="font-medium text-zinc-100 hover:underline">
                  {run.name ?? shortId(run.id)}
                </Link>
                {run.parent_run_id && (
                  <span className="ml-2 text-xs text-violet-300">fork @ step {run.fork_step}</span>
                )}
                <div className="max-w-md truncate font-mono text-xs text-zinc-500">
                  {formatCommand(run.command)}
                </div>
              </td>
              <td className="py-2 pr-4">
                <StatusBadge status={run.status} />
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{run.step_count}</td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {formatNumber(run.tokens_in)} / {formatNumber(run.tokens_out)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatMs(run.latency_ms)}</td>
              <td className="py-2 text-zinc-400">{formatDate(run.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
