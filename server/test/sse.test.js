// SSE parsing and chat.completion rebuilding. Pure functions: no server, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, createChatAssembler } from '../src/sse.js';

const bytes = (text) => new TextEncoder().encode(text);

// Feeds the text to a parser in the given pieces; returns all events.
function parse(pieces) {
  const parser = createSseParser();
  const events = pieces.flatMap((piece) => parser.push(bytes(piece)));
  return [...events, ...parser.end()];
}

test('splits events at blank lines, wherever the chunks break', () => {
  const text = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
  const expected = [
    { event: null, data: '{"a":1}' },
    { event: null, data: '{"b":2}' },
    { event: null, data: '[DONE]' },
  ];
  assert.deepEqual(parse([text]), expected);
  // Every split point, including mid-line and between the two \n.
  for (let i = 1; i < text.length; i++) {
    assert.deepEqual(parse([text.slice(0, i), text.slice(i)]), expected, `split at ${i}`);
  }
});

test('handles \\r\\n line ends, event names, comments and multi-line data', () => {
  const text = ': keep-alive\r\n\r\nevent: message_start\r\ndata: line 1\r\ndata: line 2\r\n\r\n';
  assert.deepEqual(parse([text]), [{ event: 'message_start', data: 'line 1\nline 2' }]);
});

test('a last event with no blank line is still returned at the end', () => {
  assert.deepEqual(parse(['data: [DONE]']), [{ event: null, data: '[DONE]' }]);
});

test('a multi-byte character split across chunks is decoded whole', () => {
  const all = bytes('data: "é"\n\n');
  const parser = createSseParser();
  const events = [...parser.push(all.slice(0, 8)), ...parser.push(all.slice(8)), ...parser.end()];
  assert.deepEqual(events, [{ event: null, data: '"é"' }]);
});

// Runs chunk objects (and '[DONE]') through an assembler.
function assemble(chunks) {
  const assembler = createChatAssembler();
  for (const chunk of chunks) assembler.add(typeof chunk === 'string' ? chunk : JSON.stringify(chunk));
  return assembler.result();
}

const meta = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'rewind-qwen' };

test('rebuilds a text answer, with usage when the stream sends it', () => {
  const { response, error } = assemble([
    { ...meta, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { ...meta, choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
    { ...meta, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { ...meta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...meta, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    '[DONE]',
  ]);
  assert.equal(error, null);
  assert.deepEqual(response, {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'rewind-qwen',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
});

test('merges tool call pieces by index', () => {
  const { response } = assemble([
    { ...meta, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
      { index: 0, id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '' } },
    ] } }] },
    { ...meta, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
    { ...meta, choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: 'th":"."}' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] } }] },
    { ...meta, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
  assert.deepEqual(response.choices[0], {
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ],
    },
    finish_reason: 'tool_calls',
  });
  assert.equal('usage' in response, false);
});

test('notes problems without throwing, keeping what it rebuilt', () => {
  const cut = assemble([{ ...meta, choices: [{ index: 0, delta: { content: 'par' } }] }]);
  assert.equal(cut.response.choices[0].message.content, 'par');
  assert.equal(cut.error, 'upstream stream ended before [DONE]');

  const bad = assemble(['{oops', { ...meta, choices: [{ index: 0, delta: { content: 'x' } }] }, '[DONE]']);
  assert.equal(bad.error, 'upstream stream had a non-JSON event');
  assert.equal(bad.response.choices[0].message.content, 'x');

  const failed = assemble([{ error: { message: 'model crashed' } }, '[DONE]']);
  assert.equal(failed.error, 'upstream stream error: model crashed');
  assert.equal(failed.response, null);
});
