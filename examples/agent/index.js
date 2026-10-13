import { runAgent } from './agent.js';

// Usage: node examples/agent/index.js "sort the files"
// The final answer goes to stdout; progress logs go to stderr, so the answer
// can be piped or captured on its own.
// Exit code 0 = finished, 1 = failed or hit the step limit. `rewind run` uses
// the exit code to set the run's status.

const task = process.argv.slice(2).join(' ').trim();
if (!task) {
  console.error('Usage: node index.js "<task>"');
  process.exit(1);
}

try {
  const { ok, answer } = await runAgent(task);
  if (answer) console.log(answer);
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error(`Agent failed: ${err.message}`);
  process.exitCode = 1;
}
