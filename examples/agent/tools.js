import path from 'node:path';
import fs from 'node:fs/promises';
import { safePath, SANDBOX_DIR } from './safePath.js';

// read_file returns at most this many bytes, so one big file can't flood the
// model's context.
export const MAX_READ_BYTES = 4096;

// Tool schemas in OpenAI function-calling format, sent with every LLM request.
export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files and folders inside a folder of the sandbox.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the sandbox. Use "." for the sandbox itself.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a text file. Only the first ${MAX_READ_BYTES} bytes are returned.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File relative to the sandbox.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_folder',
      description: 'Create a folder (and any missing parent folders). Does nothing if it already exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the sandbox.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move a file. If "to" is an existing folder, the file keeps its name and goes inside it. Never overwrites an existing file.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'File to move, relative to the sandbox.' },
          to: { type: 'string', description: 'New file path or an existing folder, relative to the sandbox.' },
        },
        required: ['from', 'to'],
      },
    },
  },
];

// Runs one tool call from the LLM. Never throws: failures come back as
// { error } so the agent can read the message and try something else.
export async function runTool(name, args, root = SANDBOX_DIR) {
  const tool = tools[name];
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await tool(args ?? {}, root);
  } catch (err) {
    return { error: err.message };
  }
}

const tools = {
  list_files: listFiles,
  read_file: readFile,
  create_folder: createFolder,
  move_file: moveFile,
};

async function listFiles(args, root) {
  const rel = requireString(args, 'path');
  const full = await safePath(rel, root);
  const stats = await statOrNull(full);
  if (!stats) throw new Error(`Not found: ${rel}`);
  if (!stats.isDirectory()) throw new Error(`Not a folder: ${rel}`);

  const dirents = await fs.readdir(full, { withFileTypes: true });
  const entries = dirents
    .map((d) => ({ name: d.name, type: d.isDirectory() ? 'folder' : 'file' }))
    // Plain code-unit order, not localeCompare, so the listing is identical
    // on every machine. Replay depends on requests being byte-for-byte equal.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path: rel, entries };
}

async function readFile(args, root) {
  const rel = requireString(args, 'path');
  const full = await safePath(rel, root);
  const stats = await statOrNull(full);
  if (!stats) throw new Error(`Not found: ${rel}`);
  if (!stats.isFile()) throw new Error(`Not a file: ${rel}`);

  // Read only the first MAX_READ_BYTES instead of loading the whole file.
  const handle = await fs.open(full, 'r');
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
    return {
      path: rel,
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stats.size > MAX_READ_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function createFolder(args, root) {
  const rel = requireString(args, 'path');
  const full = await safePath(rel, root);
  const stats = await statOrNull(full);
  if (stats && !stats.isDirectory()) throw new Error(`A file already exists at: ${rel}`);
  if (stats) return { path: rel, created: false };

  await fs.mkdir(full, { recursive: true });
  return { path: rel, created: true };
}

async function moveFile(args, root) {
  const fromRel = requireString(args, 'from');
  const toRel = requireString(args, 'to');
  const from = await safePath(fromRel, root);
  let to = await safePath(toRel, root);

  const fromStats = await statOrNull(from);
  if (!fromStats) throw new Error(`Not found: ${fromRel}`);
  if (!fromStats.isFile()) throw new Error(`Only files can be moved: ${fromRel}`);

  // "to" names an existing folder: move the file inside it, keeping its name.
  let toStats = await statOrNull(to);
  if (toStats?.isDirectory()) {
    to = path.join(to, path.basename(from));
    toStats = await statOrNull(to);
  }
  const toShown = path.relative(root, to).split(path.sep).join('/');

  // Checked by hand because fs.rename silently replaces an existing file.
  if (toStats) throw new Error(`Already exists, not overwriting: ${toShown}`);
  const parentStats = await statOrNull(path.dirname(to));
  if (!parentStats?.isDirectory()) {
    throw new Error(`Folder does not exist: ${path.posix.dirname(toShown)} (create it first)`);
  }

  await fs.rename(from, to);
  return { from: fromRel, to: toShown };
}

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`Missing or invalid argument: ${key}`);
  return value;
}

// fs.stat that returns null for a missing path instead of throwing.
async function statOrNull(full) {
  try {
    return await fs.stat(full);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}
