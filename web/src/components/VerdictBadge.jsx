import { verdict } from '../evals.js';

const STYLES = {
  pass: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  fail: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  running: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  never: 'text-zinc-500 ring-zinc-700',
};

const LABELS = { pass: 'PASS', fail: 'FAIL', running: 'running', never: 'not run' };

// An eval result's verdict; `result` may be null (the eval was never run).
export default function VerdictBadge({ result }) {
  const v = verdict(result);
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ring-1 ${STYLES[v]}`}>{LABELS[v]}</span>
  );
}
