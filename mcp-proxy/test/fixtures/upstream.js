// A fake "real" MCP server for proxy tests. Run directly, it serves on
// stdio and writes its pid to $PID_FILE (if set) so tests can check that
// it was shut down.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

export const TOOLS = [
  { name: 'echo', description: 'Returns its arguments as JSON text.', inputSchema: { type: 'object', properties: { b: { type: 'number' }, a: { type: 'string' } } } },
  { name: 'fail', description: 'Always fails with isError.', inputSchema: { type: 'object' } },
  { name: 'picture', description: 'Returns text and an image.', inputSchema: { type: 'object' } },
  { name: 'env', description: 'Returns ENV_CHECK from its environment.', inputSchema: { type: 'object' } },
];

export function createUpstream() {
  const server = new Server({ name: 'fake-upstream', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    switch (params.name) {
      case 'echo':
        return { content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] };
      case 'fail':
        return { content: [{ type: 'text', text: 'disk on fire' }], isError: true };
      case 'picture':
        return { content: [{ type: 'text', text: 'a dot' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] };
      case 'env':
        return { content: [{ type: 'text', text: process.env.ENV_CHECK ?? '(unset)' }] };
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
    }
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));
  await createUpstream().connect(new StdioServerTransport());
}
