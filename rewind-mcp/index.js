// Entry point: Rewind as a stdio MCP server, so an LLM client (Claude Code,
// Cursor) can query recorded runs.
//
//   node rewind-mcp/index.js
//
// The client launches this process and talks MCP over its stdin/stdout.
// Stdout carries the protocol: never console.log here, log with console.error.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRewindServer } from './src/server.js';

const log = (message) => console.error(`[rewind-mcp] ${message}`);

const trimSlash = (url) => url.replace(/\/+$/, '');
const serverUrl = trimSlash(process.env.REWIND_SERVER_URL || 'http://localhost:4000');
const intelUrl = trimSlash(process.env.INTEL_URL || 'http://localhost:8000');

await createRewindServer({ serverUrl, intelUrl }).connect(new StdioServerTransport());
log(`ready, reading from ${serverUrl} (intel: ${intelUrl})`);
