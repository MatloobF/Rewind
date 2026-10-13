import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { seed, SEED_FILES } from '../seed.js';

let tmp;  // holds the fake sandbox and an "outside" folder
let root; // fake sandbox

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-seed-'));
  root = path.join(tmp, 'sandbox');
  await fs.mkdir(root);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('writes every seed file with its exact content', async () => {
  await seed(root);
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), content, rel);
  }
});

test('removes leftovers from a previous run but keeps .gitkeep', async () => {
  await fs.writeFile(path.join(root, '.gitkeep'), '');
  await fs.mkdir(path.join(root, 'documents'));
  await fs.writeFile(path.join(root, 'documents', 'todo.md'), 'moved by the agent');

  await seed(root);

  assert.equal(await fs.access(path.join(root, 'documents')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(root, '.gitkeep')).then(() => true, () => false), true);
  assert.equal(await fs.readFile(path.join(root, 'todo.md'), 'utf8'), SEED_FILES['todo.md']);
});

test('removes a link without deleting what it points to', async () => {
  const outside = path.join(tmp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'precious.txt'), 'keep');
  await fs.symlink(outside, path.join(root, 'link'), 'junction');

  await seed(root);

  assert.equal(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8'), 'keep');
  assert.equal(await fs.access(path.join(root, 'link')).then(() => true, () => false), false);
});
