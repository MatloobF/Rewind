// Helpers for reading recorded steps. LLM steps hold OpenAI chat
// completion or Anthropic message bodies (read through llmFormat.js); tool
// steps (Phase 4) hold MCP tool calls.
import { replyMessage, requestMessages } from './llmFormat.js';

export { replyMessage, requestMessages };

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

// How many of this LLM step's request messages an earlier LLM step had
// already sent: the longest run of identical leading messages shared with
// any earlier step. Everything after that index is new at this step.
// Not just the step before: an agent can interleave separate conversations
// (Claude Code makes small side calls between its main ones).
export function previousMessageCount(steps, step) {
  const messages = requestMessages(step).map((m) => JSON.stringify(m));
  let shared = 0;
  for (const earlier of steps) {
    if (earlier.type !== 'llm' || earlier.idx >= step.idx) continue;
    shared = Math.max(shared, sharedPrefix(messages, requestMessages(earlier).map((m) => JSON.stringify(m))));
  }
  return shared;
}

// How many leading items two arrays of strings have in common.
function sharedPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
