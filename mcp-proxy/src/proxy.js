// The MCP proxy sits between an agent and a real MCP server:
//
//   agent (MCP client) <-stdio-> proxy <-stdio-> real MCP server
//
// To the agent it is an MCP server; to the real server it is an MCP client.
// It forwards tools/list and tools/call unchanged. With a recorder, each
// tools/call is also recorded as a tool step; tools/list is not a step.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const USAGE = 'usage: node mcp-proxy/index.js -- <command> [args...]';

// Everything after `--` is the real server's argv, passed to spawn as-is
// (no shell), the same way `rewind run` launches the agent.
export function parseProxyArgs(args) {
  const sep = args.indexOf('--');
  if (sep === -1) throw new Error(`missing "--" before the MCP server command\n${USAGE}`);
  if (sep > 0) throw new Error(`unknown option "${args[0]}"\n${USAGE}`);
  const command = args.slice(sep + 1);
  if (command.length === 0) throw new Error(`missing MCP server command after "--"\n${USAGE}`);
  return { command };
}

// Builds the agent-facing server around a connected client of the real one.
// `recorder` (from recorder.js) is null when there is no run to record into.
// Only tools are proxied for now: resources and prompts are not forwarded.
export function createProxy(upstream, { recorder = null } = {}) {
  const server = new Server(
    { name: 'rewind-mcp-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Results are returned as-is, including tool failures (isError: true).
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    forwardErrors(() => upstream.listTools(request.params)));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    forwardErrors(() => recorder
      ? recordedCall(upstream, request.params, recorder)
      : upstream.callTool(request.params)));

  return server;
}

// Starts a tool step and does what the server's mode says:
//   live      make the real call, then finish the step with its result
//   replay    return the parent run's result (or error) with no call
//   override  return the edited result with no call, or call the tool with
//             the edited request and finish the step as usual
// Live results (and errors) are returned exactly as the real server gave them.
async function recordedCall(upstream, params, recorder) {
  // A missing `arguments` means the same as {} in MCP, so both are stored
  // (and hashed) as {}.
  const step = await recorder.start({ name: params.name, arguments: params.arguments ?? {} });
  if (step?.mode === 'replay') return replayed(step);
  if (step?.mode === 'override' && step.response) return step.response;

  const idx = step?.idx ?? null;
  const sent = step?.mode === 'override' ? { ...params, ...step.request } : params;
  const started = Date.now();
  let result;
  try {
    result = await upstream.callTool(sent);
  } catch (err) {
    // A protocol error: there is no result, only the error (Rule 5).
    if (idx !== null) await recorder.finish(idx, { error: err.message, latency_ms: Date.now() - started });
    throw err;
  }
  if (idx !== null) {
    await recorder.finish(idx, {
      response: result,
      error: result.isError ? toolErrorText(result) : null,
      latency_ms: Date.now() - started,
    });
  }
  return result;
}

// A replayed step: the parent's result, isError results included. A step
// that was a protocol error has only its error text, "MCP error <code>: ...";
// throw it again with that code, so forwardErrors hands the agent the same
// code and message it got the first time.
function replayed({ response, error }) {
  if (response != null) return response;
  const err = new Error(error);
  const code = Number(error.match(/^MCP error (-?\d+): /)?.[1]);
  if (Number.isSafeInteger(code)) err.code = code;
  throw err;
}

// MCP tools usually report failure as a result with isError: true instead of
// a protocol error. Its text goes in the step's error column (Rule 5).
function toolErrorText(result) {
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text || 'tool returned isError with no text';
}

// When the real server answers with a protocol error, the SDK client throws
// an McpError whose message it has prefixed with "MCP error <code>: ".
// Rethrown as-is, the agent's SDK would add the prefix again, so strip it
// once: the agent then gets the same code, message and data it would have
// got without the proxy.
async function forwardErrors(call) {
  try {
    return await call();
  } catch (err) {
    if (Number.isSafeInteger(err.code)) {
      const forwarded = new Error(err.message.replace(`MCP error ${err.code}: `, ''));
      forwarded.code = err.code;
      forwarded.data = err.data;
      throw forwarded;
    }
    throw err;
  }
}
