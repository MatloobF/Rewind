import { createHash } from 'node:crypto';

// Fields that change how a response is delivered, not what is asked.
const TRANSPORT_FIELDS = ['stream', 'stream_options'];

// JSON with object keys sorted at every level, so two requests with the same
// content always give the same string. Plain JSON.stringify keeps insertion
// order, which depends on how the caller built the object.
// Array order is kept: in messages and tools, order is meaning.
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    // Like JSON.stringify: undefined inside an array becomes null.
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const parts = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined) // Like JSON.stringify: skip undefined.
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

// SHA-256 (hex) of the canonical request, minus top-level transport fields.
// The one hash function used everywhere: replay compares these hashes.
export function hashRequest(request) {
  const body = { ...request };
  for (const field of TRANSPORT_FIELDS) delete body[field];
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
