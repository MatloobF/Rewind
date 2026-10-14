// Helpers for reading recorded steps. LLM steps hold OpenAI chat
// completion bodies; tool steps (Phase 4) hold MCP tool calls.

// The assistant message an LLM step returned, or null.
export const replyMessage = (step) => step.response?.choices?.[0]?.message ?? null;

// 'error' | 'pending' | 'done'. A step with neither response nor error was
// started but never finished: still in progress if the run is running,
// otherwise the agent died mid-call.
export function stepState(step) {
  if (step.error) return 'error';
  if (step.response == null) return 'pending';
  return 'done';
}

// One line describing what the step did, for the step list.
export function stepSummary(step) {
  if (step.type === 'tool') return step.request.name ?? 'tool call';
  if (step.error) return step.error;
  const reply = replyMessage(step);
  if (!reply) return 'waiting for response';
  if (reply.tool_calls?.length) return reply.tool_calls.map((c) => c.function?.name).join(', ');
  return typeof reply.content === 'string' && reply.content ? reply.content : '(empty reply)';
}

// How many of this LLM step's request messages the previous LLM step had
// already sent. Everything after that index is new at this step.
export function previousMessageCount(steps, step) {
  const earlier = steps.filter((s) => s.type === 'llm' && s.idx < step.idx);
  return earlier.at(-1)?.request.messages?.length ?? 0;
}
