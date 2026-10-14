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

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// Body: { fork_step, fork_override?, name?, setup? } -> the new fork run.
export const forkRun = (id, body) => postJson(`/api/runs/${id}/fork`, body);
