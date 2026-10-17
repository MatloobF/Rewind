import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { fetchFailurePatterns } from '../api.js';
import { shortId } from '../format.js';

const MAX_LISTED = 50; // failures listed per open pattern

export default function Failures() {
  const [open, setOpen] = useState(() => new Set());
  const { data, error, isPending } = useQuery({
    queryKey: ['failure-patterns'],
    queryFn: fetchFailurePatterns,
    retry: false,
  });

  if (isPending) {
    return <p className="text-zinc-400">Loading failure patterns... (the first load after starting the intel service can take a few seconds)</p>;
  }
  if (error) {
    return (
      <div className="text-rose-300">
        <p>Could not load failure patterns: {error.message}</p>
        <p className="mt-2 text-sm text-zinc-400">
          Is the intel service running?{' '}
          <code className="text-zinc-200">cd intel && .venv/Scripts/python -m uvicorn main:app --reload --port 8000</code>
        </p>
      </div>
    );
  }

  const { patterns } = data;
  if (patterns.length === 0) return <p className="text-zinc-400">No failures recorded yet.</p>;

  const total = patterns.reduce((n, p) => n + p.size, 0);
  const runCount = new Set(patterns.flatMap((p) => p.failures.map((f) => f.run_id))).size;
  const largest = patterns[0].size; // sorted by size, largest first
  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div>
      <h1 className="text-xl font-semibold">Failure patterns</h1>
      <p className="mt-1 text-sm text-zinc-400">
        {total} failures in {patterns.length} patterns across {runCount} runs. Similar error messages are grouped by
        meaning (all-MiniLM-L6-v2 + HDBSCAN); replayed fork steps aren't counted.
      </p>

      <ul className="mt-6 space-y-2">
        {patterns.map((p) => (
          <li key={p.id} className="rounded border border-zinc-800">
            <button
              type="button"
              onClick={() => toggle(p.id)}
              className="w-full px-4 py-3 text-left hover:bg-zinc-900/60"
            >
              <div className="flex items-baseline gap-3">
                <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{p.size}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-100">{p.label}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {p.kind === 'cluster' ? `${p.signatures.length} similar messages` : 'one message'} ·{' '}
                  {p.run_count} {p.run_count === 1 ? 'run' : 'runs'}
                </span>
              </div>
              <div className="ml-11 mt-2 h-1.5 rounded bg-zinc-800">
                <div className="h-1.5 rounded bg-rose-400/70" style={{ width: `${(p.size / largest) * 100}%` }} />
              </div>
            </button>
            {open.has(p.id) && <PatternDetail pattern={p} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PatternDetail({ pattern }) {
  const listed = pattern.failures.slice(0, MAX_LISTED);
  return (
    <div className="border-t border-zinc-800 px-4 py-3 text-sm">
      {pattern.signatures.length > 1 && (
        <ul className="mb-3 space-y-0.5">
          {pattern.signatures.map((s) => (
            <li key={s.signature} className="flex gap-3">
              <span className="w-8 shrink-0 text-right tabular-nums text-zinc-500">{s.count}</span>
              <span className="font-mono text-zinc-300">{s.signature}</span>
            </li>
          ))}
        </ul>
      )}
      <table className="w-full text-left">
        <thead className="text-xs uppercase text-zinc-500">
          <tr>
            <th className="py-1 pr-4 font-medium">Run</th>
            <th className="py-1 pr-4 font-medium">Step</th>
            <th className="py-1 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {listed.map((f, i) => (
            <tr key={`${f.run_id}-${f.idx}-${i}`} className="border-t border-zinc-900 align-top">
              <td className="py-1 pr-4">
                <Link to={`/runs/${f.run_id}`} className="hover:underline">
                  {f.run_name ?? shortId(f.run_id)}
                </Link>
              </td>
              <td className="whitespace-nowrap py-1 pr-4">
                {f.idx == null ? (
                  <span className="text-zinc-500">-</span>
                ) : (
                  <Link to={`/runs/${f.run_id}?step=${f.idx}`} className="font-mono hover:underline">
                    #{f.idx} {f.tool ?? f.type}
                  </Link>
                )}
              </td>
              <td className="py-1 font-mono text-zinc-400">{f.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pattern.failures.length > MAX_LISTED && (
        <p className="mt-2 text-xs text-zinc-500">and {pattern.failures.length - MAX_LISTED} more</p>
      )}
    </div>
  );
}
