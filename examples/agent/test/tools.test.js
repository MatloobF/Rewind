import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { runTool, toolDefinitions, MAX_READ_BYTES } from '../tools.js';

let root; // a fresh fake sandbox for every test

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-tools-'));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'b.txt'), 'bee');
  await fs.writeFile(path.join(root, 'a.txt'), 'ay');
  await fs.writeFile(path.join(root, 'docs', 'old.txt'), 'old');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exists = (rel) => fs.access(path.join(root, rel)).then(() => true, () => false);

test('there are 4 tool definitions and each one can run', async () => {
  for (const def of toolDefinitions) {
    const result = await runTool(def.function.name, {}, root);
    assert.doesNotMatch(result.error ?? '', /Unknown tool/);
  }
  assert.equal(toolDefinitions.length, 4);
});

test('unknown tool returns an error instead of throwing', async () => {
  assert.deepEqual(await runTool('delete_file', { path: 'a.txt' }, root), { error: 'Unknown tool: delete_file' });
});

test('missing arguments return an error', async () => {
  assert.match((await runTool('read_file', {}, root)).error, /Missing or invalid argument: path/);
  assert.match((await runTool('move_file', { from: 'a.txt' }, root)).error, /Missing or invalid argument: to/);
  assert.match((await runTool('list_files', undefined, root)).error, /Missing or invalid argument/);
});

test('sandbox escapes come back as errors', async () => {
  assert.match((await runTool('list_files', { path: '..' }, root)).error, /escapes/);
  assert.match((await runTool('move_file', { from: 'a.txt', to: '../a.txt' }, root)).error, /escapes/);
  assert.equal(await exists('a.txt'), true);
});

// list_files

test('list_files returns entries sorted by name with their type', async () => {
  assert.deepEqual(await runTool('list_files', { path: '.' }, root), {
    path: '.',
    entries: [
      { name: 'a.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
      { name: 'docs', type: 'folder' },
    ],
  });
});

test('list_files sorts by code unit, so uppercase comes first', async () => {
  await fs.writeFile(path.join(root, 'Z.txt'), '');
  const names = (await runTool('list_files', { path: '.' }, root)).entries.map((e) => e.name);
  assert.deepEqual(names, ['Z.txt', 'a.txt', 'b.txt', 'docs']);
});

test('list_files errors on a missing folder or a file', async () => {
  assert.deepEqual(await runTool('list_files', { path: 'nope' }, root), { error: 'Not found: nope' });
  assert.deepEqual(await runTool('list_files', { path: 'a.txt' }, root), { error: 'Not a folder: a.txt' });
});

// read_file

test('read_file returns the content', async () => {
  assert.deepEqual(await runTool('read_file', { path: 'docs/old.txt' }, root), {
    path: 'docs/old.txt',
    content: 'old',
    truncated: false,
  });
});

test('read_file caps large files', async () => {
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_READ_BYTES + 100));
  const result = await runTool('read_file', { path: 'big.txt' }, root);
  assert.equal(result.content.length, MAX_READ_BYTES);
  assert.equal(result.truncated, true);
});

test('read_file errors on a missing file or a folder', async () => {
  assert.deepEqual(await runTool('read_file', { path: 'nope.txt' }, root), { error: 'Not found: nope.txt' });
  assert.deepEqual(await runTool('read_file', { path: 'docs' }, root), { error: 'Not a file: docs' });
});

test('errors never contain the absolute sandbox path', async () => {
  const results = [
    await runTool('read_file', { path: 'nope.txt' }, root),
    await runTool('list_files', { path: 'a.txt/x' }, root),
    await runTool('move_file', { from: 'a.txt', to: 'missing/a.txt' }, root),
  ];
  for (const r of results) {
    assert.ok(r.error);
    assert.ok(!r.error.includes(root), r.error);
  }
});

// create_folder

test('create_folder creates nested folders', async () => {
  assert.deepEqual(await runTool('create_folder', { path: 'x/y' }, root), { path: 'x/y', created: true });
  assert.equal(await exists('x/y'), true);
});

test('create_folder on an existing folder is a no-op', async () => {
  assert.deepEqual(await runTool('create_folder', { path: 'docs' }, root), { path: 'docs', created: false });
});

test('create_folder errors when a file is in the way', async () => {
  assert.deepEqual(await runTool('create_folder', { path: 'a.txt' }, root), { error: 'A file already exists at: a.txt' });
});

// move_file

test('move_file moves and renames a file', async () => {
  assert.deepEqual(await runTool('move_file', { from: 'a.txt', to: 'docs/renamed.txt' }, root), {
    from: 'a.txt',
    to: 'docs/renamed.txt',
  });
  assert.equal(await exists('a.txt'), false);
  assert.equal(await fs.readFile(path.join(root, 'docs', 'renamed.txt'), 'utf8'), 'ay');
});

test('move_file into an existing folder keeps the file name', async () => {
  assert.deepEqual(await runTool('move_file', { from: 'a.txt', to: 'docs' }, root), { from: 'a.txt', to: 'docs/a.txt' });
  assert.equal(await exists('docs/a.txt'), true);
});

test('move_file never overwrites', async () => {
  await fs.writeFile(path.join(root, 'docs', 'a.txt'), 'keep me');
  const direct = await runTool('move_file', { from: 'a.txt', to: 'docs/a.txt' }, root);
  const intoFolder = await runTool('move_file', { from: 'a.txt', to: 'docs' }, root);
  assert.deepEqual(direct, { error: 'Already exists, not overwriting: docs/a.txt' });
  assert.deepEqual(intoFolder, direct);
  assert.equal(await fs.readFile(path.join(root, 'docs', 'a.txt'), 'utf8'), 'keep me');
  assert.equal(await exists('a.txt'), true);
});

test('move_file needs the target folder to exist', async () => {
  assert.deepEqual(await runTool('move_file', { from: 'a.txt', to: 'images/a.txt' }, root), {
    error: 'Folder does not exist: images (create it first)',
  });
});

test('move_file errors on a missing source or a folder', async () => {
  assert.deepEqual(await runTool('move_file', { from: 'nope.txt', to: 'docs' }, root), { error: 'Not found: nope.txt' });
  assert.deepEqual(await runTool('move_file', { from: 'docs', to: 'other' }, root), { error: 'Only files can be moved: docs' });
});
