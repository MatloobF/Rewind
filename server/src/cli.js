// The `rewind` CLI. For now one command:
//
//   rewind run [--name <name>] -- <command> [args...]
//
// Creates a run, launches the agent with its LLM base URL pointed at the
// recording proxy, and sets the run's status from the agent's exit code.
// The CLI talks only to the Rewind API, never to Postgres directly.
// Its own messages go to stderr, so the agent's stdout stays clean.
import { spawn } from 'node:child_process';

const USAGE = 'usage: rewind run [--name <name>] -- <command> [args...]';

// Parses `run` arguments. Everything after `--` is the agent's argv, passed
// to spawn as-is (no shell), so quotes and spaces survive untouched.
export function parseRunArgs(args) {
  const sep = args.indexOf('--');
  if (sep === -1) throw new Error(`missing "--" before the command\n${USAGE}`);
  const options = args.slice(0, sep);
  const command = args.slice(sep + 1);
  if (command.length === 0) throw new Error(`missing command after "--"\n${USAGE}`);

  let name = null;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--name' && options[i + 1] !== undefined) {
      name = options[++i];
    } else {
      throw new Error(`unknown or incomplete option "${options[i]}"\n${USAGE}`);
    }
  }
  return { name, command };
}

async function callApi(serverUrl, method, path, body) {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${data.error}`);
  return data;
}

const log = (message) => console.error(`[rewind] ${message}`);

// Records one run of `command`. Resolves with the exit code the CLI should
// use: the agent's own code, or 1 if it couldn't start, or 130 on Ctrl+C.
export async function recordRun({ name, command, cwd = process.cwd(), serverUrl }) {
  let run;
  try {
    run = await callApi(serverUrl, 'POST', '/api/runs', { name, command, cwd });
  } catch (err) {
    log(`could not create the run: ${err.cause?.code ?? err.message}`);
    log(`is the Rewind server running at ${serverUrl}? (cd server && npm run dev)`);
    return 1;
  }
  log(`run ${run.id} started`);

  const child = spawn(command[0], command.slice(1), {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      REWIND_RUN_ID: run.id,
      REWIND_BASE_URL: `${serverUrl}/r/${run.id}/v1`,
    },
  });

  // Ctrl+C: stop the agent; the run is marked failed when it exits. In a
  // terminal the agent usually gets Ctrl+C too and exits on its own.
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    if (child.exitCode === null) child.kill();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  // 'error' fires instead of 'exit' when the command can't start (e.g. not found).
  const exitCode = await new Promise((resolve) => {
    child.once('error', (err) => {
      log(`could not start "${command[0]}": ${err.code ?? err.message}`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1)); // null code = killed by a signal
  });
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);

  const status = exitCode === 0 && !interrupted ? 'success' : 'failed';
  try {
    await callApi(serverUrl, 'PATCH', `/api/runs/${run.id}`, { status });
    log(`run ${run.id} ${status}${interrupted ? ' (interrupted)' : ''}`);
  } catch (err) {
    // The agent already ran; report the problem but keep its exit code.
    log(`could not set the run status to ${status}: ${err.cause?.code ?? err.message}`);
  }
  return interrupted ? 130 : exitCode;
}

export async function main(args) {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'run') {
    log(USAGE);
    return 1;
  }
  let parsed;
  try {
    parsed = parseRunArgs(rest);
  } catch (err) {
    log(err.message);
    return 1;
  }
  const serverUrl = (process.env.REWIND_SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
  return recordRun({ ...parsed, serverUrl });
}
