import { useQuery } from '@tanstack/react-query';
import { fetchRuns } from './api.js';

// Placeholder until the run list page (Phase 3, step 3): proves the
// Vite -> /api -> server -> Postgres path works.
export default function App() {
  const { data, error, isPending } = useQuery({ queryKey: ['runs'], queryFn: fetchRuns });

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Rewind</h1>
      <p className="mt-2 text-zinc-400">
        {isPending && 'Loading runs...'}
        {error && `Could not load runs: ${error.message}`}
        {data && `${data.length} runs recorded.`}
      </p>
    </main>
  );
}
