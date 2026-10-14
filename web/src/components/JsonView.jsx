// Pretty-printed JSON in a scrollable block. Only the fork editor uses
// Monaco; read-only viewing doesn't need it.
export default function JsonView({ value }) {
  return (
    <pre className="max-h-96 overflow-auto rounded bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
