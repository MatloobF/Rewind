// Streamed LLM answers (server-sent events, SSE).
// With `stream: true`, an OpenAI-compatible server answers with
// `text/event-stream`: a series of `data: {chunk}` events, each a small
// delta, ended by `data: [DONE]`. The proxy forwards those bytes unchanged
// and feeds a copy through here, to rebuild the response a non-streaming
// call would have returned. So a step is stored in one shape either way.

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
