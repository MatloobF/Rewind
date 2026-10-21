// The environment an agent is launched with, by `rewind run` and by the
// server for forks and evals. Its own module so the CLI can use it without
// importing the database code that launcher.js needs.
//
//   REWIND_BASE_URL      LLM base URL for agents that read it (the sample agent)
//   ANTHROPIC_BASE_URL   the same proxy for the Anthropic SDK and Claude Code,
//                        without /v1: they add /v1/messages themselves
//   REWIND_RUN_ID        passed on to the MCP proxy, which records tool calls
//   REWIND_SERVER_URL    where the MCP proxy reaches the server
export function agentEnv(serverUrl, runId) {
  return {
    ...process.env,
    REWIND_RUN_ID: runId,
    REWIND_BASE_URL: `${serverUrl}/r/${runId}/v1`,
    ANTHROPIC_BASE_URL: `${serverUrl}/r/${runId}`,
    REWIND_SERVER_URL: serverUrl,
  };
}
