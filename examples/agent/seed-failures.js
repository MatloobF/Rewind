// Record a set of failed and error-heavy runs through the Rewind API, so the
// intel service has realistic failures to cluster. No Ollama needed: the
// steps are scripted, but they go through the same start/finish routes the
// proxies use (Rule 3: only the Node server writes).
//
// Usage: node seed-failures.js [--force]   (server must be running)
// Runs are named "[seed] ..."; it refuses to add them twice unless --force.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.REWIND_SERVER_URL || 'http://localhost:4000';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The real agent command: forking a seeded run launches the actual agent
// (it diverges at step 0, because these requests are scripted).
const COMMAND = ['node', 'examples/agent/index.js', 'sort the files'];

// --- What the agent "did" in each run -------------------------------------
// tool(name, args, error?) and llm(error?) describe one step each.
// noResponse marks a step that was started but never finished.

const tool = (name, args, error = null) => ({ type: 'tool', name, args, error });
const llm = (error = null) => ({ type: 'llm', error });
const noResponse = { type: 'llm', noResponse: true };

const SCENARIOS = [
  {
    name: 'move onto existing folders',
    status: 'failed',
    steps: [
      llm(), tool('list_files', { path: '.' }),
      llm(), tool('create_folder', { path: 'images' }),
      tool('move_file', { from: 'beach.jpg', to: 'images' }, 'Already exists, not overwriting: images'),
      tool('move_file', { from: 'report.pdf', to: 'docs' }, 'Already exists, not overwriting: docs'),
      tool('move_file', { from: 'song.mp3', to: 'music' }, 'Already exists, not overwriting: music'),
      llm('upstream request failed: UND_ERR_HEADERS_TIMEOUT'),
    ],
  },
  {
    name: 'folder name taken by a file',
    status: 'failed',
    steps: [
      llm(), tool('list_files', { path: '.' }),
      llm(), tool('create_folder', { path: 'notes' }, 'A file already exists at: notes'),
      tool('create_folder', { path: 'todo' }, 'A file already exists at: todo'),
      llm(), tool('move_file', { from: 'todo.md', to: 'notes/todo.md' }, 'Folder does not exist: notes (create it first)'),
      llm('upstream request failed: ECONNREFUSED'),
    ],
  },
  {
    name: 'tries to leave the sandbox',
    status: 'success',
    steps: [
      llm(), tool('read_file', { path: '../.env' }, 'Path escapes the sandbox: ../.env'),
      llm(), tool('list_files', { path: '/etc' }, 'Path must be relative to the sandbox: /etc'),
      llm(), tool('move_file', { from: 'notes.txt', to: '../notes.txt' }, 'Path escapes the sandbox: ../notes.txt'),
      llm(), tool('list_files', { path: '.' }),
      llm(),
    ],
  },
  {
    name: 'invents tools',
    status: 'success',
    steps: [
      llm(), tool('rename_file', { from: 'IMG_1.png', to: 'photo.png' }, 'Unknown tool: rename_file'),
      llm(), tool('delete_file', { path: 'old.tmp' }, 'Unknown tool: delete_file'),
      llm(), tool('write_file', { path: 'README.md', content: '# Files' }, 'Unknown tool: write_file'),
      llm(), tool('move_file', { from: 'IMG_1.png', to: 'images/IMG_1.png' }),
      llm(),
    ],
  },
  {
    name: 'moves files that are not there',
    status: 'failed',
    steps: [
      llm(), tool('move_file', { from: 'invoice.pdf', to: 'documents/invoice.pdf' }, 'Not found: invoice.pdf'),
      tool('move_file', { from: 'photo-2024.jpg', to: 'images/photo-2024.jpg' }, 'Not found: photo-2024.jpg'),
      llm(), tool('read_file', { path: 'summary.txt' }, 'Not found: summary.txt'),
      tool('list_files', { path: 'archive' }, 'Not found: archive'),
      llm('upstream HTTP 500: model runner has unexpectedly stopped'),
    ],
  },
  {
    name: 'bad tool arguments',
    status: 'success',
    steps: [
      llm(), tool('move_file', { from: 'a.txt' }, 'Missing or invalid argument: to'),
      llm(), tool('create_folder', { name: 'images' }, 'Missing or invalid argument: path'),
      llm(), tool('move_file', { from: 'images', to: 'pictures' }, 'Only files can be moved: images'),
      llm(), tool('create_folder', { path: 'images' }),
      llm(),
    ],
  },
  {
    name: 'stuck listing files',
    status: 'failed', // hit the step limit: no step has an error
    steps: [
      llm(), tool('list_files', { path: '.' }),
      llm(), tool('list_files', { path: '.' }),
      llm(), tool('list_files', { path: '.' }),
      llm(), tool('list_files', { path: '.' }),
      llm(), tool('list_files', { path: '.' }),
      llm(),
    ],
  },
  {
    name: 'model went away',
    status: 'failed',
    steps: [
      llm(), tool('list_files', { path: '.' }),
      llm('upstream request failed: UND_ERR_HEADERS_TIMEOUT'),
      llm('upstream request failed: UND_ERR_HEADERS_TIMEOUT'),
      llm('upstream HTTP 404: model "rewind-qwen" not found, try pulling it first'),
    ],
  },
  {
    name: 'killed mid-call',
    status: 'failed',
    steps: [llm(), tool('list_files', { path: '.' }), noResponse],
  },
  {
    name: 'reads a folder as a file',
    status: 'success',
    steps: [
      llm(), tool('read_file', { path: 'images' }, 'Not a file: images'),
      llm(), tool('list_files', { path: 'notes.txt' }, 'Not a folder: notes.txt'),
      llm(), tool('list_files', { path: '.' }),
      llm(),
    ],
  },
];

// --- Turning steps into API calls ------------------------------------------

async function api(method, route, body) {
  const res = await fetch(`${SERVER}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${data?.error ?? ''}`);
  return data;
}

// The request each proxy would have recorded for this step.
function stepRequest(step, i) {
  if (step.type === 'tool') return { name: step.name, arguments: step.args };
  return {
    model: 'rewind-qwen',
    messages: [
      { role: 'system', content: 'You organise files in a sandbox folder.' },
      { role: 'user', content: `sort the files (seeded step ${i})` },
    ],
  };
}

// The finish body, shaped like the real proxies write it.
function stepResult(step) {
  const latency_ms = step.type === 'llm' ? 2000 : 5;
  if (step.type === 'tool') {
    const text = JSON.stringify(step.error ? { error: step.error } : { ok: true });
    return {
      response: { content: [{ type: 'text', text }], ...(step.error && { isError: true }) },
      error: step.error ? text : null,
      latency_ms,
    };
  }
  if (step.error) return { error: step.error, latency_ms };
  return {
    response: { choices: [{ message: { role: 'assistant', content: 'Next step.' }, finish_reason: 'stop' }] },
    latency_ms,
    tokens_in: 900,
    tokens_out: 40,
  };
}

async function recordScenario(scenario) {
  const run = await api('POST', '/runs', { name: `[seed] ${scenario.name}`, command: COMMAND, cwd: REPO_ROOT });
  for (const [i, step] of scenario.steps.entries()) {
    const { idx } = await api('POST', `/runs/${run.id}/steps`, { type: step.type, request: stepRequest(step, i) });
    if (!step.noResponse) await api('PATCH', `/runs/${run.id}/steps/${idx}`, stepResult(step));
  }
  await api('PATCH', `/runs/${run.id}`, { status: scenario.status });
  return run;
}

async function main() {
  const force = process.argv.includes('--force');
  const runs = await api('GET', '/runs');
  if (!force && runs.some((r) => r.name?.startsWith('[seed]'))) {
    console.log('Seeded runs already exist; pass --force to add another set.');
    return;
  }
  for (const scenario of SCENARIOS) {
    const run = await recordScenario(scenario);
    const errors = scenario.steps.filter((s) => s.error).length;
    console.log(`${run.id.slice(0, 8)}  ${scenario.status.padEnd(7)}  ${errors} step errors  [seed] ${scenario.name}`);
  }
}

main().catch((err) => {
  console.error(`seed-failures: ${err.message} (is the Rewind server running at ${SERVER}?)`);
  process.exit(1);
});
