// Rewind as an MCP server. Each tool is a read-only question about the
// recorded data, answered by calling the Rewind API over HTTP.
//
// Tool results go into the calling LLM's context, so they are kept small:
// only the fields that help answer a question, as one JSON text block.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJson } from './api.js';

// The fields of a run that list_runs returns. Left out: cwd (not useful to
// an LLM) and fork_override (can hold a whole edited LLM response).
const RUN_FIELDS = [
  'id', 'name', 'status', 'command', 'created_at',
  'parent_run_id', 'fork_step', 'diverged_at_step',
  'step_count', 'tokens_in', 'tokens_out', 'latency_ms',
];

export function createRewindServer({ serverUrl }) {
  const server = new McpServer({ name: 'rewind', version: '0.1.0' });

  server.registerTool('list_runs', {
    title: 'List runs',
    description:
      'List recorded agent runs, newest first, with status, step count and token totals. ' +
      'Forks have a parent_run_id and fork_step; diverged_at_step is set when a fork\'s replay stopped matching its parent.',
    inputSchema: {
      status: z.enum(['running', 'success', 'failed']).optional()
        .describe('Only return runs with this status'),
      limit: z.number().int().min(1).max(100).default(20)
        .describe('Maximum number of runs to return (1-100, default 20)'),
    },
  }, ({ status, limit }) => toolResult(async () => {
    // The API returns the 100 newest runs; filtering them here keeps the
    // API unchanged.
    const runs = await getJson(serverUrl, '/api/runs');
    return runs
      .filter((run) => !status || run.status === status)
      .slice(0, limit)
      .map((run) => pick(run, RUN_FIELDS));
  }));

  return server;
}

// Runs a tool's work and wraps its answer as an MCP tool result. Failures
// (API down, 404, ...) come back as isError results, not thrown errors, so
// the LLM sees the message and can tell the user what went wrong.
async function toolResult(work) {
  try {
    const data = await work();
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
