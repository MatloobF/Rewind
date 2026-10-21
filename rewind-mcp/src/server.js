// Rewind as an MCP server. Each tool is a read-only question about the
// recorded data, answered by calling the Rewind API over HTTP.
//
// Tool results go into the calling LLM's context, so they are kept small
// (see summary.js), as one JSON text block.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJson } from './api.js';
import { RUN_FIELDS, pick, summarizeRun } from './summary.js';

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

  server.registerTool('get_run', {
    title: 'Get run',
    description:
      'Get one run with a compact summary of every step, in order. LLM steps show the reply text and tool calls ' +
      '(not the whole conversation); tool steps show the tool, its arguments and its result. Long text is clipped ' +
      'and marked "(+N chars)". replayed: true means a fork copied the step from its parent instead of making the call.',
    inputSchema: {
      // z.guid() accepts any 8-4-4-4-12 hex id, like the server's isUuid.
      // (z.uuid() also checks the version digit, which the server doesn't.)
      run_id: z.guid().describe('The run id, e.g. from list_runs'),
    },
  }, ({ run_id }) => toolResult(async () =>
    summarizeRun(await getJson(serverUrl, `/api/runs/${run_id}`))));

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
