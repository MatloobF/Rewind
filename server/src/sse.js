// Streamed LLM answers (server-sent events, SSE).
// With `stream: true`, the server answers with `text/event-stream`:
//   OpenAI format     `data: {chunk}` events, each a small delta, then
//                     `data: [DONE]`
//   Anthropic format  named events (message_start, content_block_delta, ...)
//                     that build the message block by block, then message_stop
// The proxy forwards those bytes unchanged and feeds a copy through here, to
// rebuild the response a non-streaming call would have returned. So a step is
// stored in one shape either way. For replay, the stored response is turned
// back into a stream (chatChunks, messageEvents).

// Splits a byte stream into SSE events. Network chunks can end mid-line or
// mid-event, so an incomplete line is kept until the rest arrives. An event
// ends at a blank line; its `data:` lines are joined with newlines. Lines end
// in \n or \r\n (a lone \r, also allowed by the spec, isn't used by LLM APIs).
export function createSseParser() {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = { event: null, data: [] };

  // Reads one line; returns a finished event at a blank line, else null.
  function readLine(line) {
    if (line === '') {
      const done = event;
      event = { event: null, data: [] };
      return done.data.length > 0 ? { event: done.event, data: done.data.join('\n') } : null;
    }
    if (line.startsWith(':')) return null; // A comment, e.g. a keep-alive.
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One space after the colon is part of the syntax, not the value.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') event.data.push(value);
    if (field === 'event') event.event = value;
    return null;
  }

  function readLines(lines) {
    const events = [];
    for (const line of lines) {
      const done = readLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (done) events.push(done);
    }
    return events;
  }

  return {
    // Takes the next bytes; returns the events they completed.
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Incomplete until its \n arrives.
      return readLines(lines);
    },
    // At the end of the stream: the last event, if it had no blank line.
    end() {
      const rest = buffer + decoder.decode();
      buffer = '';
      return readLines([rest, '']);
    },
  };
}

// The other way round: a stored chat.completion as SSE text, for a streaming
// agent in a fork (a replayed or overridden step makes no live call, so there
// is no upstream stream to forward). Each choice goes out as one chunk holding
// the whole message, which streaming clients accept like many small ones.
// usage is sent only if the agent asked for it, as upstream would.
export function chatChunks(response, { includeUsage = false } = {}) {
  const { object, choices = [], usage, ...meta } = response;
  const chunk = (fields) => `data: ${JSON.stringify({ ...meta, object: 'chat.completion.chunk', ...fields })}\n\n`;
  let text = '';
  for (const { index, message = {}, finish_reason } of choices) {
    const delta = { ...message };
    if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, i) => ({ index: i, ...call }));
    text += chunk({ choices: [{ index, delta, finish_reason }] });
  }
  if (includeUsage && usage) text += chunk({ choices: [], usage });
  return `${text}data: [DONE]\n\n`;
}

// Rebuilds a chat.completion from chat.completion.chunk events.
// Each chunk's choices[i].delta holds the new part of the message: text is
// appended, tool calls are merged by their index (their arguments arrive as
// pieces of a JSON string), finish_reason comes near the end. usage arrives
// in a last chunk with no choices, only if the agent asked for it with
// stream_options.include_usage.
// Never throws: the proxy must keep forwarding whatever upstream sends, so a
// bad event is noted in `error` (the first one wins) and skipped.
export function createChatAssembler() {
  let meta = {}; // id, created, model, ...: everything but the deltas.
  const choices = [];
  let usage = null;
  let sawChunk = false;
  let sawDone = false;
  let error = null;

  function addChoice({ index = 0, delta = {}, finish_reason }) {
    choices[index] ??= { index, message: { role: 'assistant', content: null }, finish_reason: null };
    const choice = choices[index];
    for (const [key, value] of Object.entries(delta)) {
      if (key === 'tool_calls') addToolCalls(choice.message, value);
      else if (key === 'role') choice.message.role = value;
      // content, refusal, reasoning, ...: string parts are appended.
      else if (typeof value === 'string') choice.message[key] = (choice.message[key] ?? '') + value;
      else if (value != null) choice.message[key] = value;
    }
    if (finish_reason != null) choice.finish_reason = finish_reason;
  }

  function addToolCalls(message, deltas) {
    message.tool_calls ??= [];
    for (const { index = 0, id, type, function: fn = {} } of deltas) {
      message.tool_calls[index] ??= { id: null, type: 'function', function: { name: '', arguments: '' } };
      const call = message.tool_calls[index];
      if (id) call.id = id;
      if (type) call.type = type;
      // The name comes whole, in the call's first delta; arguments in pieces.
      if (fn.name) call.function.name = fn.name;
      if (fn.arguments) call.function.arguments += fn.arguments;
    }
  }

  return {
    // Takes one event's data text.
    add(data) {
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        error ??= 'upstream stream had a non-JSON event';
        return;
      }
      // Some servers report a failure mid-stream as an event, e.g. Ollama:
      // data: {"error":{"message":"..."}}
      if (chunk?.error) {
        const message = chunk.error.message ?? chunk.error;
        error ??= `upstream stream error: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
        return;
      }
      sawChunk = true;
      const { object, choices: chunkChoices, usage: chunkUsage, ...rest } = chunk;
      meta = { ...meta, ...rest };
      for (const choice of chunkChoices ?? []) addChoice(choice);
      if (chunkUsage) usage = chunkUsage;
    },

    // The rebuilt response (null if no chunk came), and the first problem
    // seen. A stream that stops without [DONE] was cut short.
    result() {
      const response = sawChunk ? { ...meta, object: 'chat.completion', choices: choices.filter(Boolean) } : null;
      if (response && usage) response.usage = usage;
      return { response, error: error ?? (sawDone ? null : 'upstream stream ended before [DONE]') };
    },
  };
}

// Rebuilds an Anthropic message from its stream events:
//   message_start        the message, with empty content and the input usage
//   content_block_start  block i begins (text, tool_use, thinking, ...)
//   content_block_delta  more of block i: text_delta.text, thinking_delta.thinking,
//                        signature_delta.signature are appended; a tool's
//                        input arrives as input_json_delta.partial_json, pieces
//                        of a JSON string, parsed at content_block_stop
//   message_delta        stop_reason, and usage (output_tokens) merged in
//   message_stop         the end; a stream without it was cut short
// ping events are keep-alives. Never throws, like createChatAssembler.
export function createMessageAssembler() {
  let message = null;
  const content = [];
  const json = []; // Unparsed tool input text, per block index.
  let sawStop = false;
  let error = null;

  // A tool block's collected input JSON becomes its input. No pieces at all
  // means the input from content_block_start ({}) stands.
  function finishBlock(index) {
    if (!json[index]) return;
    try {
      content[index].input = JSON.parse(json[index]);
    } catch {
      error ??= `upstream stream had invalid tool input JSON in block ${index}`;
    }
    json[index] = undefined;
  }

  function addDelta(index, { type, partial_json, ...fields }) {
    const block = content[index];
    if (!block) {
      error ??= `upstream stream sent a ${type} for unknown block ${index}`;
      return;
    }
    if (partial_json != null) json[index] = (json[index] ?? '') + partial_json;
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string') block[key] = (block[key] ?? '') + value;
      else if (key === 'citation') (block.citations ??= []).push(value);
    }
  }

  return {
    add(data) {
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        error ??= 'upstream stream had a non-JSON event';
        return;
      }
      switch (event?.type) {
        case 'message_start':
          message = { ...event.message };
          break;
        case 'content_block_start':
          content[event.index] = { ...event.content_block };
          break;
        case 'content_block_delta':
          addDelta(event.index, event.delta ?? {});
          break;
        case 'content_block_stop':
          finishBlock(event.index);
          break;
        case 'message_delta':
          if (!message) break;
          Object.assign(message, event.delta);
          if (event.usage) message.usage = { ...message.usage, ...event.usage };
          break;
        case 'message_stop':
          sawStop = true;
          break;
        case 'error': {
          const text = event.error?.message ?? event.error;
          error ??= `upstream stream error: ${typeof text === 'string' ? text : JSON.stringify(text)}`;
          break;
        }
        // ping, and event types added later: nothing to record.
      }
    },

    result() {
      json.forEach((_, index) => finishBlock(index)); // A block cut off before its stop.
      const response = message ? { ...message, content: content.filter(Boolean) } : null;
      return { response, error: error ?? (sawStop ? null : 'upstream stream ended before message_stop') };
    },
  };
}

// The field of each block type that streams in deltas, and its delta type.
// Other block types (redacted_thinking, ...) arrive whole in their start event.
const STREAMED_FIELDS = {
  text: { field: 'text', delta: 'text_delta' },
  thinking: { field: 'thinking', delta: 'thinking_delta' },
};

// A stored Anthropic message as SSE text, for a streaming agent in a fork.
// Each block is sent as start (streamed field empty), one delta with all of
// it, and stop. The full usage goes in message_start, and output_tokens again
// in message_delta, as the API does.
export function messageEvents(response) {
  const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  const { content = [], stop_reason = null, stop_sequence = null, ...rest } = response;
  let text = event('message_start', { message: { ...rest, content: [], stop_reason: null, stop_sequence: null } });

  content.forEach((block, index) => {
    const streamed = STREAMED_FIELDS[block.type];
    if (streamed) {
      text += event('content_block_start', { index, content_block: { ...block, [streamed.field]: '' } });
      text += event('content_block_delta', { index, delta: { type: streamed.delta, [streamed.field]: block[streamed.field] } });
    } else if ('input' in block) {
      // tool_use, server_tool_use: the input goes out as a JSON string.
      text += event('content_block_start', { index, content_block: { ...block, input: {} } });
      text += event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      text += event('content_block_start', { index, content_block: block });
    }
    text += event('content_block_stop', { index });
  });

  const usage = rest.usage?.output_tokens != null ? { output_tokens: rest.usage.output_tokens } : undefined;
  text += event('message_delta', { delta: { stop_reason, stop_sequence }, ...(usage && { usage }) });
  return text + event('message_stop', {});
}
