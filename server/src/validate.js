// Small input checks shared by the API and the proxy.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checking the id shape before querying gives a 400 instead of a Postgres
// cast error (500).
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A fork's override at its fork step, one of:
//   { kind: 'response', response: {...} }  serve this result, no call
//   { kind: 'request',  request:  {...} }  send this edited request live
// Returns an error message, or null if the shape is valid.
export function forkOverrideError(override) {
  if (!isPlainObject(override)) return 'fork_override must be an object';
  const { kind } = override;
  if (kind !== 'response' && kind !== 'request') {
    return "fork_override.kind must be 'response' or 'request'";
  }
  if (!isPlainObject(override[kind])) return `fork_override.${kind} must be an object`;
  if (Object.keys(override).length !== 2) {
    return `fork_override must have only "kind" and "${kind}"`;
  }
  return null;
}

// An argv array for spawn (no shell): non-empty, strings only.
export const isArgv = (v) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string');
