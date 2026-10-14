import { Link, useParams } from 'react-router';

// Placeholder until the timeline (Phase 3, step 4).
export default function RunPage() {
  const { id } = useParams();
  return (
    <div>
      <Link to="/" className="text-sm text-zinc-400 hover:underline">&larr; All runs</Link>
      <p className="mt-4 text-zinc-400">Timeline for run <code>{id}</code> comes next.</p>
    </div>
  );
}
