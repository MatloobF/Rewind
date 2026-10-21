// LLM steps come in two formats (step.format): 'openai' chat completions or
// 'anthropic' messages. The UI shows both as OpenAI-style chat messages
// ({ role, content, tool_calls, tool_call_id }), so Message and the step
// helpers only know one shape. Anthropic content blocks are mapped:
//   text         -> content (joined)
//   thinking     -> thinking (shown dimmed)
//   tool_use     -> tool_calls, with the input as a JSON-string argument
//   tool_result  -> a separate { role: 'tool' } message, as in OpenAI
// Other blocks (image, document, ...) show as a [type] placeholder, not their
// data (an image is a long base64 string).

const isAnthropic = (step) => step.format === 'anthropic';

// The messages this LLM step sent. Anthropic keeps the system prompt in its
// own field; here it becomes the first message, as in OpenAI.
export function requestMessages(step) {
  const request = step.request ?? {};
  if (!isAnthropic(step)) return request.messages ?? [];
  const system = request.system == null ? [] : [{ role: 'system', content: blocksText(request.system) }];
  return [...system, ...(request.messages ?? []).flatMap(fromAnthropic)];
}

// The assistant message this LLM step got back, or null.
export function replyMessage(step) {
  if (!isAnthropic(step)) return step.response?.choices?.[0]?.message ?? null;
  const content = step.response?.content;
  if (!Array.isArray(content)) return null; // No reply yet, or an error body.
  return fromAnthropic({ role: step.response.role ?? 'assistant', content })[0];
}

// One Anthropic message as one or more chat messages. Tool results come first
// (the API requires them first in a user message), then the rest.
function fromAnthropic({ role, content }) {
  if (typeof content === 'string') return [{ role, content }];
  const blocks = content ?? [];
  const results = blocks
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: `${block.is_error ? '(error) ' : ''}${blocksText(block.content ?? '')}`,
    }));
  const rest = blocks.filter((block) => block.type !== 'tool_result');
  if (rest.length === 0 && results.length > 0) return results;

  const message = { role, content: blocksText(rest) };
  const thinking = rest.filter((block) => block.type === 'thinking').map((block) => block.thinking);
  if (thinking.length) message.thinking = thinking.join('\n\n');
  const calls = rest
    .filter((block) => block.type === 'tool_use' || block.type === 'server_tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));
  if (calls.length) message.tool_calls = calls;
  return [...results, message];
}

// The text of a string or of content blocks. Blocks shown elsewhere
// (thinking, tool calls) are skipped; unknown ones leave a placeholder.
const SHOWN_ELSEWHERE = ['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'];

function blocksText(content) {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => !SHOWN_ELSEWHERE.includes(block.type))
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n\n');
}
