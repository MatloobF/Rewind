import { formatMs, formatNumber } from '../format.js';
import { stepState, stepSummary } from '../steps.js';

const STATE_DOT = {
  done: 'bg-emerald-400',
  error: 'bg-rose-400',
  pending: 'bg-zinc-500',
};

export default function StepList({ steps, selectedIdx, onSelect }) {
  return (
    <ol className="space-y-1">
      {steps.map((step) => {
        const selected = step.idx === selectedIdx;
        return (
          <li key={step.idx}>
            <button
              type="button"
              onClick={() => onSelect(step.idx)}
              className={`w-full rounded px-3 py-2 text-left ${selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[stepState(step)]}`} />
                <span className="font-mono text-zinc-500">#{step.idx}</span>
                <span className="font-semibold uppercase text-zinc-300">{step.type}</span>
                {step.replayed && <span className="text-violet-300">replayed</span>}
                <span className="ml-auto tabular-nums text-zinc-500">
                  {formatMs(step.latency_ms)}
                  {step.tokens_out != null && ` · ${formatNumber(step.tokens_out)} tok`}
                </span>
              </div>
              <div className="mt-1 truncate text-sm text-zinc-300">{stepSummary(step)}</div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
