// One-line descriptions of the loops the intel service detects
// (GET /intel/runs/:id/loops). Kept apart from the component so it can be tested.

export function describeLoop(loop) {
  if (loop.kind === 'tool_cycle') {
    const calls = loop.tools.join(' → ');
    return loop.period === 1
      ? `${calls} called ${loop.repeats} times in a row with the same arguments`
      : `${calls} repeated ${loop.repeats} times in a row`;
  }
  if (loop.kind === 'repeated_llm_request') {
    return `the same LLM request was sent ${loop.repeats} times`;
  }
  return `${loop.kind} (${loop.repeats} times)`;
}
