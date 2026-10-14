// Entry point: wraps a real MCP server so its tool calls can be recorded.
//
//   node mcp-proxy/index.js -- <command> [args...]
//
// Launch this wherever you would launch the real server (an agent, Claude
// Code's `claude mcp add`, Cursor's MCP config). Stdout carries the MCP
// protocol to the agent: never console.log here, log with console.error.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseProxyArgs, createProxy } from './src/proxy.js';
import { createRecorder } from './src/recorder.js';

const log = (message) => console.error(`[rewind-mcp-proxy] ${message}`);

let command;
try {
  ({ command } = parseProxyArgs(process.argv.slice(2)));
} catch (err) {
  log(err.message);
  process.exit(1);
}

// The real server gets the proxy's full environment, the same as if it had
// been launched directly. (By default the SDK passes only a few "safe"
// variables, which would make the proxy change the server's behavior.)
// Its stderr goes straight through to ours.
const upstream = new Client({ name: 'rewind-mcp-proxy', version: '0.1.0' });
try {
  await upstream.connect(new StdioClientTransport({
    command: command[0],
    args: command.slice(1),
    env: process.env,
    stderr: 'inherit',
  }));
} catch (err) {
  log(`could not start the MCP server "${command[0]}": ${err.message}`);
  process.exit(1);
}

// If the real server dies, the proxy can't do anything useful: exit so the
// agent sees the connection close, as it would without the proxy.
upstream.onclose = () => {
  log('the MCP server exited');
  process.exit(1);
};

// `rewind run` sets REWIND_RUN_ID (passed down by the agent). Without it
// there is no run to record into, and the proxy is a plain passthrough.
const runId = process.env.REWIND_RUN_ID;
let recorder = null;
if (runId) {
  const serverUrl = (process.env.REWIND_SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
  recorder = createRecorder({ runId, serverUrl, log });
  log(`recording tool calls into run ${runId}`);
} else {
  log('REWIND_RUN_ID is not set: passing tool calls through without recording');
}

await createProxy(upstream, { recorder }).connect(new StdioServerTransport());

// The agent closing our stdin means it is done. Shut the real server down
// the same way (close its stdin, kill it only if it doesn't exit) and exit.
process.stdin.once('end', async () => {
  upstream.onclose = undefined;
  await upstream.close();
  process.exit(0);
});
