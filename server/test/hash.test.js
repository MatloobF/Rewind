import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashRequest, withTransportOf } from '../src/hash.js';

const request = {
  model: 'rewind-qwen',
  temperature: 0,
  messages: [
    { role: 'system', content: 'You organize files.' },
    { role: 'user', content: 'sort the files' },
  ],
  tools: [{ type: 'function', function: { name: 'list_files', parameters: { type: 'object' } } }],
};

test('same request with different key order gives the same hash', () => {
  const reordered = {
    tools: [{ function: { parameters: { type: 'object' }, name: 'list_files' }, type: 'function' }],
    messages: [
      { content: 'You organize files.', role: 'system' },
      { content: 'sort the files', role: 'user' },
    ],
    temperature: 0,
    model: 'rewind-qwen',
  };
  assert.equal(hashRequest(reordered), hashRequest(request));
});

test('hash is 64 hex chars and stable across calls', () => {
  const h = hashRequest(request);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashRequest(request), h);
});

test('stream and stream_options are ignored', () => {
  const streamed = { ...request, stream: true, stream_options: { include_usage: true } };
  assert.equal(hashRequest(streamed), hashRequest(request));
});

test('model, temperature and message changes all change the hash', () => {
  const base = hashRequest(request);
  assert.notEqual(hashRequest({ ...request, model: 'other' }), base);
  assert.notEqual(hashRequest({ ...request, temperature: 0.7 }), base);
  const edited = structuredClone(request);
  edited.messages[1].content = 'sort the files please';
  assert.notEqual(hashRequest(edited), base);
});

test('array order matters', () => {
  const swapped = { ...request, messages: [...request.messages].reverse() };
  assert.notEqual(hashRequest(swapped), hashRequest(request));
});

test('only top-level stream is dropped', () => {
  // A nested "stream" key is real content, not a transport flag.
  const a = { ...request, metadata: { stream: 'x' } };
  const b = { ...request, metadata: {} };
  assert.notEqual(hashRequest(a), hashRequest(b));
});

test('hashRequest does not mutate its input', () => {
  const input = { ...request, stream: true };
  hashRequest(input);
  assert.equal(input.stream, true);
});

test('canonicalJson matches JSON.stringify for undefined and nested values', () => {
  assert.equal(canonicalJson({ b: undefined, a: [1, undefined] }), '{"a":[1,null]}');
  assert.equal(canonicalJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
  assert.equal(canonicalJson('héllo "q"'), JSON.stringify('héllo "q"'));
});

test('withTransportOf swaps in the other request\'s transport fields only', () => {
  const edited = { ...request, model: 'other', stream: false };
  const agent = { ...request, stream: true, stream_options: { include_usage: true } };
  assert.deepEqual(withTransportOf(edited, agent), { ...request, model: 'other', stream: true, stream_options: { include_usage: true } });
  // Fields the agent didn't send are removed, not kept from the edit.
  assert.deepEqual(withTransportOf({ ...request, stream: true }, request), request);
  assert.equal(edited.stream, false); // Input untouched.
});
