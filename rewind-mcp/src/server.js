// Rewind as an MCP server. Each tool is a read-only question about the
// recorded data, answered by calling the Rewind API over HTTP.
//
// Tool results go into the calling LLM's context, so they are kept small
// (see summary.js), as one JSON text block.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getJson } from './api.js';
import { RUN_FIELDS, pick, summarizeRun, summarizePattern } from './summary.js';

const INTEL = { service: 'Rewind intel service' };

export function createRewindServer({ serverUrl, intelUrl }) {
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

  // The intel tools fail on their own: with the intel service down, they
  // return an error and the run tools above keep working.
  server.registerTool('get_failure_patterns', {
    title: 'Get failure patterns',
    description:
      'Group the failures across all runs (errored steps, and failed runs) into patterns of similar errors, ' +
      'biggest first. Each pattern has its most common error signatures and a few example failures with the ' +
      'run_id and step idx to inspect with get_run. kind "single" means one signature that matched no cluster.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(10)
        .describe('Maximum number of patterns to return (1-50, default 10)'),
    },
  }, ({ limit }) => toolResult(async () => {
    // Long timeout: the first call after the intel service starts waits
    // for its embedding model to load (~17 s).
    const { patterns } = await getJson(intelUrl, '/failures/clusters', { ...INTEL, timeoutMs: 60_000 });
    return {
      total_patterns: patterns.length,
      patterns: patterns.slice(0, limit).map(summarizePattern),
    };
  }));

  server.registerTool('get_run_loops', {
    title: 'Get run loops',
    description:
      'Find loops in one run. kind "tool_cycle": the same sequence of tool calls repeated back to back ' +
      '(tools, period = calls per cycle, repeats). kind "repeated_llm_request": the identical LLM request sent ' +
      'more than once. step_idxs are the step idx values in get_run. An empty list means no loops were found.',
    inputSchema: {
      run_id: z.guid().describe('The run id, e.g. from list_runs'),
    },
  }, ({ run_id }) => toolResult(() => getJson(intelUrl, `/runs/${run_id}/loops`, INTEL)));

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
