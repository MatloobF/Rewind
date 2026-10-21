// Saves the API responses the web UI reads into web/demo/data, for the
// read-only demo build (npm run build:demo). Reads through the server and
// intel APIs, never Postgres directly. Both must be running.
//
//   npm run export:demo
//
// /api/runs/<id>/tree is saved as demo/data/api/runs/<id>/tree.json, the
// path src/demo.js reads it from.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_URL = (process.env.REWIND_SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
const INTEL_URL = (process.env.INTEL_URL || 'http://localhost:8000').replace(/\/+$/, '');
const DATA_DIR = fileURLToPath(new URL('../demo/data', import.meta.url));

// Development checks, not worth showing. ('mcp-proxy check (step 4)' stays:
// its tool errors are part of the failure clusters, which intel computes
// over all runs, so dropping it would leave counts that don't add up.)
const EXCLUDED_NAMES = new Set([
  'phase2-e2e',
  'phase10 streaming check',
  'phase10 docker check',
]);

async function get(baseUrl, apiPath) {
  const res = await fetch(`${baseUrl}${apiPath}`);
  if (!res.ok) throw new Error(`GET ${apiPath}: HTTP ${res.status}`);
  return res.json();
}

async function save(apiPath, data) {
  const file = path.join(DATA_DIR, `${apiPath}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

// Finished runs that aren't excluded, and aren't forks of an excluded run.
// A running run would make the UI poll forever.
function pickRuns(allRuns) {
  const kept = new Map(
    allRuns.filter((r) => r.status !== 'running' && !EXCLUDED_NAMES.has(r.name)).map((r) => [r.id, r]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of kept.values()) {
      if (run.parent_run_id && !kept.has(run.parent_run_id)) {
        kept.delete(run.id);
        changed = true;
      }
    }
  }
  return kept;
}

async function main() {
  const allRuns = await get(SERVER_URL, '/api/runs');
  const kept = pickRuns(allRuns);
  const skipped = new Set(allRuns.filter((r) => !kept.has(r.id)).map((r) => r.id));

  await rm(DATA_DIR, { recursive: true, force: true });
  const saved = [];
  const saveAll = async (apiPath, data) => {
    await save(apiPath, data);
    saved.push([apiPath, data]);
  };

  await saveAll('/api/runs', allRuns.filter((r) => kept.has(r.id)));
  for (const id of kept.keys()) {
    await saveAll(`/api/runs/${id}`, await get(SERVER_URL, `/api/runs/${id}`));
    const tree = await get(SERVER_URL, `/api/runs/${id}/tree`);
    await saveAll(`/api/runs/${id}/tree`, { ...tree, runs: tree.runs.filter((r) => kept.has(r.id)) });
    await saveAll(`/intel/runs/${id}/loops`, await get(INTEL_URL, `/runs/${id}/loops`));
  }
  await saveAll('/intel/failures/clusters', await get(INTEL_URL, '/failures/clusters'));

  const evals = await get(SERVER_URL, '/api/evals');
  await saveAll('/api/evals', evals);
  for (const ev of evals) await saveAll(`/api/evals/${ev.id}`, await get(SERVER_URL, `/api/evals/${ev.id}`));

  // A skipped run's id anywhere in the saved data would be a dead link (and
  // data we meant to leave out), so name each place it shows up.
  for (const [apiPath, data] of saved) {
    const text = JSON.stringify(data);
    for (const id of skipped) {
      if (text.includes(id)) console.error(`warning: ${apiPath} mentions skipped run ${id}`);
    }
  }
  console.error(`saved ${saved.length} files for ${kept.size} runs and ${evals.length} evals to ${DATA_DIR}`);
}

await main();
