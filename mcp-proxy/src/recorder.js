// Records tool steps through the Rewind API's start/finish routes. The proxy
// never writes to Postgres itself (Rule 3): the server owns idx and replay.
//
// Recording fails open: if the API is down, slow, or refuses the step, the
// recorder logs to stderr and the tool call still happens. Recording must
// never change what the agent sees (Rule 2).

// How long to wait for the Rewind API before giving up on recording a step,
// so a hung server can't stall the agent.
const API_TIMEOUT_MS = 5000;

export function createRecorder({ runId, serverUrl, log, timeoutMs = API_TIMEOUT_MS }) {
  async function callApi(method, path, body) {
    const res = await fetch(`${serverUrl}/api/runs/${runId}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${data.error ?? res.statusText}`);
    return data;
  }

  const reason = (err) => err.cause?.code ?? err.message;

  return {
    // Starts a step. Returns its idx, or null if it couldn't be recorded.
    async start(request) {
      try {
        const { idx, mode } = await callApi('POST', '/steps', { type: 'tool', request });
        // Phase 5 adds 'replay' and 'override'. Until the proxy handles them,
        // say so loudly and make the live call.
        if (mode !== 'live') log(`step ${idx}: mode "${mode}" is not supported yet, calling the tool live`);
        return idx;
      } catch (err) {
        log(`could not record tool call "${request.name}": ${reason(err)}`);
        return null;
      }
    },

    // Finishes a step with { response, error, latency_ms }.
    async finish(idx, result) {
      try {
        await callApi('PATCH', `/steps/${idx}`, result);
      } catch (err) {
        log(`could not save the result of step ${idx}: ${reason(err)}`);
      }
    },
  };
}
