// Records tool steps through the Rewind API's start/finish routes. The proxy
// never writes to Postgres itself (Rule 3): the server owns idx and replay.
//
// Recording fails open: if the API is down, slow, or refuses the step, the
// recorder logs to stderr and the tool call still happens. Recording must
// never change what the agent sees (Rule 2).
//
// Except in a fork run, which fails closed: there the server may have meant
// to replay this step, and calling the tool live instead would repeat its
// side effects (e.g. move a file again). So the agent gets an error instead.

// How long to wait for the Rewind API before giving up on recording a step,
// so a hung server can't stall the agent.
const API_TIMEOUT_MS = 5000;

export function createRecorder({ runId, serverUrl, log, timeoutMs = API_TIMEOUT_MS }) {
  let isFork = false;

  async function callApi(method, path, body) {
    const res = await fetch(`${serverUrl}/api/runs/${runId}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${data.error ?? res.statusText}`);
    return data;
  }

  const reason = (err) => err.cause?.code ?? err.message;

  return {
    // Asks the server once whether this run is a fork. If it can't be
    // reached, recording stays fail-open (and the fork's LLM calls, which go
    // through the same server, would fail anyway).
    async lookUpRun() {
      try {
        const run = await callApi('GET', '');
        isFork = run.parent_run_id != null;
      } catch (err) {
        log(`could not look up run ${runId}: ${reason(err)}; recording will fail open`);
      }
      return { isFork };
    },

    // Starts a step. Returns the server's answer ({ idx, mode, ... }), or
    // null if it couldn't be recorded. In a fork, throws instead of null.
    async start(request) {
      try {
        return await callApi('POST', '/steps', { type: 'tool', request });
      } catch (err) {
        if (isFork) {
          throw new Error(`Rewind could not start tool call "${request.name}" in fork run ${runId}: ${reason(err)}`);
        }
        log(`could not record tool call "${request.name}": ${reason(err)}`);
        return null;
      }
    },

    // Finishes a step with { response, error, latency_ms }. The call already
    // happened, so even in a fork a failure here is only logged.
    async finish(idx, result) {
      try {
        await callApi('PATCH', `/steps/${idx}`, result);
      } catch (err) {
        log(`could not save the result of step ${idx}: ${reason(err)}`);
      }
    },
  };
}
