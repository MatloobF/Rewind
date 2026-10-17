// Shared by the CLI commands: calls to the Rewind API, and log lines on
// stderr so an agent's stdout stays clean.

export async function callApi(serverUrl, method, path, body) {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${data.error}`);
  return data;
}

export const log = (message) => console.error(`[rewind] ${message}`);
