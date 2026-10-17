import { useQuery } from '@tanstack/react-query';
import { fetchRunLoops } from '../api.js';
import { describeLoop } from '../loops.js';

// A warning above the timeline when the intel service sees the agent
// repeating itself. Optional: if the intel service isn't running, it shows
// nothing, so the run page never depends on Python.
export default function LoopWarning({ run, onSelectStep }) {
  const { data } = useQuery({
    // status in the key: check again once a recording run finishes.
    queryKey: ['loops', run.id, run.status],
    queryFn: () => fetchRunLoops(run.id),
    enabled: run.status !== 'running',
    retry: false,
  });

  const loops = data?.loops ?? [];
  if (loops.length === 0) return null;

  return (
    <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <p className="font-medium text-amber-300">Possible loop</p>
      <ul className="mt-1 space-y-1 text-amber-100/90">
        {loops.map((loop, i) => (
          <li key={i}>
            {describeLoop(loop)}: steps{' '}
            {loop.step_idxs.map((idx, j) => (
              <span key={idx}>
                {j > 0 && ', '}
                <button type="button" onClick={() => onSelectStep(idx)} className="font-mono underline">
                  #{idx}
                </button>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
