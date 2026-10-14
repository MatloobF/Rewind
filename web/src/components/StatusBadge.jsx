const STYLES = {
  running: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  success: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  failed: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
};

export default function StatusBadge({ status }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ring-1 ${STYLES[status] ?? ''}`}>
      {status}
    </span>
  );
}
