// GET requests to the Rewind REST API and the intel service. The MCP server
// never reads Postgres itself: the API already does the queries (step
// totals, fork trees, eval results), so it is the one place that knows how
// to answer them, and the intel service is only reachable over HTTP anyway.

// How long to wait before giving up, so a hung service can't stall the
// LLM that called the tool.
const TIMEOUT_MS = 5000;

// Throws an Error whose message is written for the LLM reading the tool
// result: it says which service failed and what to check.
export async function getJson(baseUrl, path, { service = 'Rewind server', timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err.name === 'TimeoutError'
      ? `no answer in ${timeoutMs} ms`
      : (err.cause?.code ?? err.cause?.message ?? err.message);
    throw new Error(`${service} not reachable at ${baseUrl} (${reason}). Is it running?`);
  }
  const data = await res.json().catch(() => ({}));
  // The Node API answers errors with { error }; FastAPI (intel) with { detail }.
  if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}: ${data.error ?? data.detail ?? res.statusText}`);
  return data;
}
