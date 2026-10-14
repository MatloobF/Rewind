// One chat message (OpenAI format): its role, text and any tool calls.

const ROLE_STYLES = {
  system: 'text-amber-300',
  user: 'text-sky-300',
  assistant: 'text-emerald-300',
  tool: 'text-violet-300',
};

// Tool call arguments arrive as a JSON string. Short ones stay on one line
// (an agent may make 15 calls in one reply); long ones are pretty-printed.
function prettyArgs(args) {
  try {
    const parsed = JSON.parse(args);
    const oneLine = JSON.stringify(parsed);
    return oneLine.length <= 80 ? oneLine : JSON.stringify(parsed, null, 2);
  } catch {
    return args;
  }
}

export default function Message({ message }) {
  const { role, content, tool_calls: toolCalls } = message;
  // content is usually a string, but the format also allows an array of parts.
  const text = typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content, null, 2);

  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className={`mb-1 text-xs font-semibold uppercase ${ROLE_STYLES[role] ?? 'text-zinc-400'}`}>
        {role}
        {message.tool_call_id && (
          <span className="ml-2 font-normal normal-case text-zinc-500">{message.tool_call_id}</span>
        )}
      </div>
      {text && <div className="whitespace-pre-wrap break-words text-sm text-zinc-200">{text}</div>}
      {toolCalls?.map((call) => (
        <div key={call.id} className="mt-1 flex gap-2 rounded bg-zinc-900 px-2 py-1 font-mono text-xs">
          <span className="shrink-0 text-violet-300" title={call.id}>
            {call.function?.name}
          </span>
          <pre className="overflow-x-auto text-zinc-300">{prettyArgs(call.function?.arguments ?? '')}</pre>
        </div>
      ))}
    </div>
  );
}
