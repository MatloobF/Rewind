// A stand-in agent for CLI and fork tests. Modes:
//   call <text>       one LLM call through REWIND_BASE_URL, then print a JSON report
//   calls <text>...   one LLM call per text, in order; exit 1 if any fails
//   require <path>    exit 0 if the file exists, 1 if not
//   exit <code>       exit with that code
//   sleep             wait (until killed)
import fs from 'node:fs';

const [mode, arg] = process.argv.slice(2);

function chat(text) {
  return fetch(`${process.env.REWIND_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: text }] }),
  });
}

if (mode === 'call') {
  const res = await chat(arg);
  const reply = await res.json();
  console.log(JSON.stringify({
    runId: process.env.REWIND_RUN_ID,
    baseUrl: process.env.REWIND_BASE_URL,
    arg,
    reply: reply.choices[0].message.content,
  }));
} else if (mode === 'calls') {
  for (const text of process.argv.slice(3)) {
    if (!(await chat(text)).ok) process.exit(1);
  }
} else if (mode === 'require') {
  process.exit(fs.existsSync(arg) ? 0 : 1);
} else if (mode === 'exit') {
  process.exit(Number(arg));
} else if (mode === 'sleep') {
  setTimeout(() => {}, 60_000);
}
