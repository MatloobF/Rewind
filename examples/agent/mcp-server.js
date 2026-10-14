// The sample agent's file tools as an MCP server over stdio.
//
//   node examples/agent/mcp-server.js
//
// It serves the same four tools from tools.js, unchanged, so safePath and
// the sandbox rules stay in one place. Stdout carries the MCP protocol:
// never console.log here, log with console.error.
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions, runTool } from './tools.js';
import { SANDBOX_DIR } from './safePath.js';

// Builds the server. `root` is a parameter only so tests can use a temporary
// sandbox; the stdio entry point below always uses the real one.
export function createServer(root = SANDBOX_DIR) {
  // The low-level Server takes plain JSON Schemas, so the schemas in
  // tools.js are reused as-is (the high-level McpServer would need zod).
  const server = new Server(
    { name: 'rewind-sample-files', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // OpenAI's { type, function: { name, description, parameters } } becomes
  // MCP's { name, description, inputSchema }. Same order as tools.js.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map(({ function: fn }) => ({
      name: fn.name,
      description: fn.description,
      inputSchema: fn.parameters,
    })),
  }));

  // runTool never throws, it returns { error } instead. MCP tools report
  // that with isError: true (a normal result, not a protocol error), so the
  // agent still gets the message and can fix its next call.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await runTool(name, args, root);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: 'error' in result,
    };
  });

  return server;
}

// Start on stdio only when run directly, not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
  console.error('rewind-sample-files MCP server running on stdio');
}
