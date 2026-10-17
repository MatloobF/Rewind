// The optional setup argv run before an agent, shared by the fork and eval
// editors. Replayed tool steps don't run and an eval starts fresh, so for
// the sample agent, setup resets the sandbox to its messy starting files.

export const SAMPLE_SETUP = ['node', 'examples/agent/seed.js'];
export const isSampleAgent = (command) => command.some((arg) => arg.includes('examples/agent/index.js'));

// The setup field holds a JSON argv array, e.g. ["node", "examples/agent/seed.js"].
// JSON instead of a command line, so there's no shell-style quoting to parse.
export function parseSetup(text) {
  try {
    const argv = JSON.parse(text);
    if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) return { value: argv };
  } catch {
    // fall through to the message below
  }
  return { error: 'Setup must be a JSON array of strings, e.g. ["node", "examples/agent/seed.js"].' };
}
