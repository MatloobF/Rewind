import OpenAI from 'openai';

// qwen2.5:7b with a 16k context, built from ./Modelfile.
export const MODEL = 'rewind-qwen';

// Hard cap on LLM calls per run, so a confused model can't loop forever.
// Sorting the seed files takes ~20 tool calls, so 25 leaves a little room.
export const MAX_STEPS = 25;

// Fixed text with no timestamps or random IDs: replay matches requests by
// hash, so the same task must always produce byte-for-byte the same request.
export const SYSTEM_PROMPT = `You are a file organizer agent. You work only inside a sandbox folder, using the tools you are given. All paths are relative to the sandbox; use "." for the sandbox itself.

How to work:
1. Call list_files on "." to see what is there. Look inside existing folders too.
2. If a file's type is unclear from its name, call read_file on it.
3. Create folders with create_folder, then move every file into a fitting folder with move_file, one file per call.
4. If a tool returns an error, read it and fix your next call.
5. When every file is organized, reply with a short summary of what you did and do not call any more tools.`;

// Creates the OpenAI-compatible client. REWIND_BASE_URL is set by the
// `rewind run` CLI to point at the recording proxy; otherwise talk to Ollama.
export function createClient() {
  return new OpenAI({
    baseURL: process.env.REWIND_BASE_URL || 'http://localhost:11434/v1',
    // Ollama ignores the key, but the SDK refuses to start without one.
    apiKey: 'ollama',
  });
}

// Runs the agent loop: call the LLM, run any tools it asks for, send the
// results back, repeat until it answers without tool calls or hits the cap.
// `tools` is { definitions, call } from toolClient.js (MCP, or in-process
// in tests). Returns { ok, answer, steps }. Throws only if the LLM call
// itself fails.
export async function runAgent(task, {
  tools,
  client = createClient(),
  model = MODEL,
  maxSteps = MAX_STEPS,
  log = (msg) => console.error(msg),
} = {}) {
  if (!tools) throw new Error('runAgent needs a tools option');
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: tools.definitions,
      temperature: 0,
    });
    const message = response.choices[0].message;
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      log(`[step ${step}] done`);
      return { ok: true, answer: message.content ?? '', steps: step };
    }

    // Run tool calls one at a time, in order. Rewind assumes a sequential
    // agent (one call at a time), so no Promise.all here.
    for (const call of toolCalls) {
      const content = await runToolCall(call, tools);
      log(`[step ${step}] ${call.function.name} ${call.function.arguments} -> ${content}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  log(`Stopped: hit the ${maxSteps}-step limit`);
  return { ok: false, answer: '', steps: maxSteps };
}

// The model sends tool arguments as a JSON string, which small models
// sometimes get wrong. Bad JSON becomes an { error } the model can fix,
// without calling the tool. Returns the tool message text.
async function runToolCall(call, tools) {
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return JSON.stringify({ error: `Arguments are not valid JSON: ${call.function.arguments}` });
  }
  return tools.call(call.function.name, args);
}
