// The MCP proxy sits between an agent and a real MCP server:
//
//   agent (MCP client) <-stdio-> proxy <-stdio-> real MCP server
//
// To the agent it is an MCP server; to the real server it is an MCP client.
// It forwards tools/list and tools/call unchanged. Recording of tool calls
// is added around callTool (step 4); everything else stays a passthrough.
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
// Only tools are proxied for now: resources and prompts are not forwarded.
export function createProxy(upstream) {
  const server = new Server(
    { name: 'rewind-mcp-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Results are returned as-is, including tool failures (isError: true).
  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    forwardErrors(() => upstream.listTools(request.params)));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    forwardErrors(() => upstream.callTool(request.params)));

  return server;
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
