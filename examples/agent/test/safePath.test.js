import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { safePath } from '../safePath.js';

let tmp;      // temp folder holding the sandbox and an "outside" folder
let root;     // fake sandbox for these tests
let outside;  // a folder next to the sandbox that must stay unreachable

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-safepath-'));
  root = path.join(tmp, 'sandbox');
  outside = path.join(tmp, 'outside');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('resolves a plain relative path inside the sandbox', async () => {
  assert.equal(await safePath('docs/a.txt', root), path.join(root, 'docs', 'a.txt'));
});

test('"." and "" mean the sandbox root', async () => {
  assert.equal(await safePath('.', root), root);
  assert.equal(await safePath('', root), root);
});

test('allows a path that does not exist yet (e.g. a move target)', async () => {
  assert.equal(await safePath('new/dir/b.txt', root), path.join(root, 'new', 'dir', 'b.txt'));
});

test('allows ".." that stays inside the sandbox', async () => {
  assert.equal(await safePath('docs/../a.txt', root), path.join(root, 'a.txt'));
});

test('allows names that merely start with two dots', async () => {
  assert.equal(await safePath('..notes.txt', root), path.join(root, '..notes.txt'));
});

test('rejects ".." escapes', async () => {
  for (const p of ['..', '../outside/secret.txt', 'docs/../../outside', '..\\outside']) {
    await assert.rejects(safePath(p, root), /escapes/, p);
  }
});

test('rejects absolute paths', async () => {
  for (const p of [path.join(outside, 'secret.txt'), '/etc/passwd', '\\Windows']) {
    await assert.rejects(safePath(p, root), /relative/, p);
  }
});

test('rejects drive-letter paths, including drive-relative "C:foo"', async () => {
  for (const p of ['C:\\Windows', 'C:/Windows', 'C:foo', 'D:secret.txt']) {
    await assert.rejects(safePath(p, root), /relative/, p);
  }
});

test('rejects UNC paths', async () => {
  await assert.rejects(safePath('\\\\server\\share\\file', root), /relative/);
});

test('rejects non-strings and null bytes', async () => {
  await assert.rejects(safePath(undefined, root), /string/);
  await assert.rejects(safePath(42, root), /string/);
  await assert.rejects(safePath('a\0b', root), /null byte/);
});

test('rejects a link inside the sandbox that points outside', async () => {
  // A junction is a Windows directory link that needs no admin rights;
  // on other systems Node ignores the type and makes a normal symlink.
  const link = path.join(root, 'escape');
  await fs.symlink(outside, link, 'junction');
  try {
    await assert.rejects(safePath('escape/secret.txt', root), /link/);
    await assert.rejects(safePath('escape/new.txt', root), /link/);
    await assert.rejects(safePath('escape', root), /link/);
  } finally {
    await fs.rm(link, { recursive: false, force: true });
  }
});
