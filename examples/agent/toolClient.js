// The agent's view of its tools: { definitions, call(name, args), close() }.
// `definitions` are OpenAI function-calling schemas sent with every LLM
// request, and `call` returns the text that goes back to the model as the
// tool message. Two implementations share that shape:
//   - connectMcpTools: the real one, over MCP (used by index.js)
//   - localTools: runs tools.js in-process (used by tests)
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolDefinitions, runTool } from './tools.js';

export const MCP_SERVER_PATH = fileURLToPath(new URL('./mcp-server.js', import.meta.url));
export const MCP_PROXY_PATH = fileURLToPath(new URL('../../mcp-proxy/index.js', import.meta.url));

// Launches the file-tools MCP server behind Rewind's MCP proxy and connects:
//   agent -> mcp-proxy -> mcp-server.js
// Without REWIND_RUN_ID (not started by `rewind run`) the proxy just passes
// calls through, so the agent works the same with or without Rewind.
export async function connectMcpTools() {
  const client = new Client({ name: 'rewind-sample-agent', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, // the same node binary running the agent
    args: [MCP_PROXY_PATH, '--', process.execPath, MCP_SERVER_PATH],
    env: rewindEnv(),
  }));
  return mcpTools(client);
}

// The SDK passes only a few "safe" variables to the process it launches,
// so the ones the proxy needs to record the run are passed explicitly.
function rewindEnv() {
  const env = {};
  for (const key of ['REWIND_RUN_ID', 'REWIND_SERVER_URL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// Wraps an already connected MCP client.
export async function mcpTools(client) {
  const { tools } = await client.listTools();
  return {
    // MCP's { name, description, inputSchema } back to OpenAI's format, with
    // keys in the same order as tools.js, so the model sees byte-for-byte the
    // same request as before MCP. Replay matches requests by hash.
    definitions: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),

    async call(name, args) {
      try {
        const result = await client.callTool({ name, arguments: args });
        // Failed tools still return text (with isError: true), and that text
        // is the { error } JSON the model reads, so isError needs no special
        // handling here.
        return textOf(result);
      } catch (err) {
        // A protocol error (server crashed, timeout) becomes an error the
        // model can see, the same as a failed tool.
        return JSON.stringify({ error: `Tool call failed: ${err.message}` });
      }
    },

    close: () => client.close(),
  };
}

// In-process tools on a given sandbox root, for tests.
export function localTools(root) {
  return {
    definitions: toolDefinitions,
    call: async (name, args) => JSON.stringify(await runTool(name, args, root)),
    close: async () => {},
  };
}

// Joins the text blocks of an MCP tool result. Our server always sends one.
function textOf(result) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
