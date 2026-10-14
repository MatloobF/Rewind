// Small fetch helpers for the Rewind API. Paths are relative because Vite
// proxies /api to the server in dev.

async function getJson(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => null);
  // The API answers errors with { error: message }.
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export const fetchRuns = () => getJson('/api/runs');
export const fetchRun = (id) => getJson(`/api/runs/${id}`);
export const fetchRunTree = (id) => getJson(`/api/runs/${id}/tree`);
