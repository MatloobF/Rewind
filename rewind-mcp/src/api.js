// GET requests to the Rewind REST API (and, later, the intel service).
// The MCP server never reads Postgres itself: the API already does the
// queries (step totals, fork trees, eval results), so it is the one place
// that knows how to answer them.

// How long to wait before giving up, so a hung server can't stall the
// LLM that called the tool.
const TIMEOUT_MS = 5000;

// Throws an Error whose message is written for the LLM reading the tool
// result: it says which service failed and what to check.
export async function getJson(baseUrl, path, { timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : (err.cause?.code ?? err.cause?.message ?? err.message);
    throw new Error(`Rewind server not reachable at ${baseUrl} (${reason}). Is it running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}: ${data.error ?? res.statusText}`);
  return data;
}
