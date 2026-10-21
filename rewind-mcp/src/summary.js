// Compact views of runs and steps for tool results. Whatever a tool returns
// goes into the calling LLM's context, so long text is clipped and the
// repeated parts of a run are dropped.
//
// The biggest saving is on LLM steps: each request holds the whole
// conversation so far plus the tool definitions, sent again at every turn.
// The summary keeps only what is new at that step: the reply and its tool
// calls, plus how many messages were sent.

const CLIP_CHARS = 200;

// The fields of a run shown in list_runs and get_run. Left out: cwd (not
// useful to an LLM) and fork_override (get_run shows it clipped).
export const RUN_FIELDS = [
  'id', 'name', 'status', 'command', 'created_at',
  'parent_run_id', 'fork_step', 'diverged_at_step',
  'step_count', 'tokens_in', 'tokens_out', 'latency_ms',
];

export function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

// Cuts text to `max` characters and says how much was cut, so the LLM
// knows it isn't seeing everything. Non-strings are shown as JSON.
export function clip(value, max = CLIP_CHARS) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

// A run from GET /api/runs/:id (the run row with all its steps) as
// { run, task, steps }. That route has no totals, so they are added up here.
export function summarizeRun(run) {
  const steps = run.steps ?? [];
  const sum = (key) => steps.reduce((total, step) => total + (step[key] ?? 0), 0);
  return {
    run: {
      ...pick(run, RUN_FIELDS),
      fork_override: clip(run.fork_override),
      step_count: steps.length,
      tokens_in: sum('tokens_in'),
      tokens_out: sum('tokens_out'),
      latency_ms: sum('latency_ms'),
    },
    task: clip(findTask(steps)),
    steps: steps.map(summarizeStep),
  };
}

// The agent's task: the first user message of the run's first LLM call.
function findTask(steps) {
  const first = steps.find((step) => step.type === 'llm');
  const message = first?.request?.messages?.find((m) => m.role === 'user');
  return message ? messageText(message.content) : null;
}

export function summarizeStep(step) {
  const summary = {
    idx: step.idx,
    type: step.type,
    replayed: step.replayed,
    latency_ms: step.latency_ms,
    error: clip(step.error),
  };
  // Started but never finished: the agent died mid-call (or is still in it).
  if (step.response == null && step.error == null) summary.state = 'no_response';
  return step.type === 'llm'
    ? { ...summary, ...llmDetails(step) }
    : { ...summary, ...toolDetails(step) };
}

// LLM steps hold OpenAI chat completion or Anthropic message bodies
// (step.format); both are summarized in the same fields.
function llmDetails({ format, request, response, tokens_in, tokens_out }) {
  return {
    format,
    tokens_in,
    tokens_out,
    messages_sent: request?.messages?.length ?? 0,
    ...(format === 'anthropic' ? anthropicReply(response) : openaiReply(response)),
  };
}

function openaiReply(response) {
  const choice = response?.choices?.[0];
  const message = choice?.message;
  return {
    reply: clip(messageText(message?.content)),
    tool_calls: (message?.tool_calls ?? []).map((call) => ({
      name: call.function?.name ?? null,
      arguments: clip(call.function?.arguments),
    })),
    finish_reason: choice?.finish_reason ?? null,
  };
}

// An Anthropic reply is a list of content blocks: text, tool_use, thinking...
// stop_reason is its finish_reason (end_turn, tool_use, max_tokens, ...).
function anthropicReply(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return {
    reply: clip(blocksText(blocks)),
    tool_calls: blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({ name: block.name ?? null, arguments: clip(block.input ?? {}) })),
    finish_reason: response?.stop_reason ?? null,
  };
}

// Tool steps hold MCP tool calls: request { name, arguments }, response an
// MCP result { content: [...], isError? }.
function toolDetails({ request, response }) {
  return {
    tool: request?.name ?? null,
    arguments: clip(request?.arguments ?? {}),
    result: clip(blocksText(response?.content)),
    is_error: response?.isError === true,
  };
}

// A failure pattern from the intel service, without its full member list
// (every failure in the pattern): the top signatures and a few examples,
// each with the run_id and idx to look at with get_run.
export function summarizePattern(pattern) {
  return {
    ...pick(pattern, ['id', 'kind', 'label', 'size', 'run_count']),
    signatures: pattern.signatures.slice(0, 5),
    examples: pattern.failures.slice(0, 3).map((failure) => ({
      ...pick(failure, ['run_id', 'run_name', 'idx', 'type', 'tool']),
      message: clip(failure.message),
    })),
  };
}

// The fields of an eval shown in list_evals and get_eval. Left out: cwd,
// and setup (only matters for running an eval, and these tools only read).
const EVAL_FIELDS = ['id', 'input_task', 'source_run_id', 'command', 'assertions', 'created_at'];

// An eval from GET /api/evals, with its pass counts and latest result.
export function summarizeEvalListItem(evalRow) {
  const latest = evalRow.latest_result;
  return {
    ...pick(evalRow, EVAL_FIELDS),
    ...pick(evalRow, ['result_count', 'checked_count', 'passed_count']),
    latest_result: latest ? summarizeResult(latest) : null,
  };
}

// An eval from GET /api/evals/:id with its newest `limit` results.
export function summarizeEval(evalRow, limit) {
  return {
    ...pick(evalRow, EVAL_FIELDS),
    total_results: evalRow.results.length,
    results: evalRow.results.slice(0, limit).map(summarizeResult),
  };
}

// One eval result. passed is null while its run is still going.
// (run_status is only there in get_eval's results.)
function summarizeResult(result) {
  return {
    run_id: result.run_id,
    ...(result.run_status !== undefined && { run_status: result.run_status }),
    passed: result.passed,
    failures: summarizeFailures(result.failures),
    created_at: result.created_at,
  };
}

// Each failure stores its whole assertion, which the eval's assertions list
// already holds: keep its index into that list and its type.
function summarizeFailures(failures) {
  return (failures ?? []).map((failure) => ({
    index: failure.index,
    type: failure.assertion?.type ?? null,
    message: clip(failure.message),
  }));
}

// Chat message content is a string, or an array of parts like { type: 'text', text }.
function messageText(content) {
  if (typeof content === 'string') return content || null;
  return blocksText(content);
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text || null;
}
