// Launches the agent for a run the server created itself (a fork), the way
// `rewind run` does for a new run: spawn(argv[0], argv.slice(1), { cwd })
// with no shell, and the run's proxy URLs in its environment. Sets the run's
// status when the agent exits.
//
// The agent's output goes to the server's terminal. If the server stops
// while an agent is running, that run stays 'running', the same as when
// `rewind run` is killed hard.
import { spawn } from 'node:child_process';
import { agentEnv } from './agentEnv.js';
import { setRunStatus } from './runs.js';

const log = (message) => console.error(`[rewind] ${message}`);

// `setup` is an optional argv run first in the same cwd, e.g. a script that
// resets the files the agent works on. Replayed tool steps don't run, so
// without it the agent starts live in whatever state the world is in now.
// Resolves with the run's final status, and never rejects.
export async function launchRun(run, { serverUrl, setup = null }) {
  let status = null;
  if (setup) {
    const code = await runProcess(setup, { cwd: run.cwd, env: process.env });
    if (code !== 0) {
      log(`setup for run ${run.id} exited with ${code}, so the agent was not started`);
      status = 'failed';
    }
  }
  if (status === null) {
    const code = await runProcess(run.command, {
      cwd: run.cwd,
      env: agentEnv(serverUrl, run.id),
    });
    status = code === 0 ? 'success' : 'failed';
  }

  try {
    await setRunStatus(run.id, status);
    log(`run ${run.id} ${status}`);
  } catch (err) {
    log(`could not set run ${run.id} to ${status}: ${err.message}`);
  }
  return status;
}

// Spawns argv with no shell. Resolves with its exit code, or 1 if it
// couldn't start or was killed by a signal.
function runProcess(argv, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', (err) => {
      log(`could not start "${argv[0]}": ${err.code ?? err.message}`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
