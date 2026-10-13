import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The only folder the agent's file tools may touch.
export const SANDBOX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox');

// Turns a path from the LLM (relative to the sandbox) into an absolute path
// inside the sandbox. Throws if the path could point anywhere else.
// `root` is a parameter only so tests can use a temporary sandbox.
export async function safePath(userPath, root = SANDBOX_DIR) {
  if (typeof userPath !== 'string') {
    throw new Error('Path must be a string');
  }
  if (userPath.includes('\0')) {
    throw new Error('Path contains a null byte');
  }
  // "C:foo" is not absolute by path.isAbsolute, but on Windows it means
  // "foo in the current folder of drive C", so reject any drive letter.
  if (path.isAbsolute(userPath) || /^[a-zA-Z]:/.test(userPath)) {
    throw new Error(`Path must be relative to the sandbox: ${userPath}`);
  }

  const resolved = path.resolve(root, userPath);
  if (!isInside(root, resolved)) {
    throw new Error(`Path escapes the sandbox: ${userPath}`);
  }

  // The text check above can't see symlinks: "link/secret.txt" looks fine but
  // may point outside. Resolve the real location of the deepest part of the
  // path that exists (the full path may not exist yet, e.g. a move target).
  const realRoot = await fs.realpath(root);
  const realExisting = await fs.realpath(await deepestExisting(resolved));
  if (!isInside(realRoot, realExisting)) {
    throw new Error(`Path escapes the sandbox through a link: ${userPath}`);
  }

  return resolved;
}

// True if `target` is `root` itself or somewhere below it.
function isInside(root, target) {
  const rel = path.relative(root, target);
  // Check for a ".." segment, not a ".." prefix: "..notes.txt" is a valid name.
  // On Windows, a path on another drive gives an absolute `rel`.
  const goesUp = rel === '..' || rel.startsWith('..' + path.sep);
  return !goesUp && !path.isAbsolute(rel);
}

async function deepestExisting(p) {
  let current = p;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
