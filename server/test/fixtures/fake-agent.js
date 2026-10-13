// A stand-in agent for CLI tests. Modes:
//   call <text>   one LLM call through REWIND_BASE_URL, then print a JSON report
//   exit <code>   exit with that code
//   sleep         wait (until killed)
const [mode, arg] = process.argv.slice(2);

if (mode === 'call') {
  const res = await fetch(`${process.env.REWIND_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: arg }] }),
  });
  const reply = await res.json();
  console.log(JSON.stringify({
    runId: process.env.REWIND_RUN_ID,
    baseUrl: process.env.REWIND_BASE_URL,
    arg,
    reply: reply.choices[0].message.content,
  }));
} else if (mode === 'exit') {
  process.exit(Number(arg));
} else if (mode === 'sleep') {
  setTimeout(() => {}, 60_000);
}
