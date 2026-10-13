// Small input checks shared by the API and the proxy.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checking the id shape before querying gives a 400 instead of a Postgres
// cast error (500).
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
