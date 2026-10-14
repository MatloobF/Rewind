// Lines up a fork's steps with its parent's for the run diff page.
//
// Rows are matched by idx, not by content: a fork replays its parent step for
// step, so the same idx means "the same point in the run" until the fork goes
// its own way. After that, comparing request_hash shows whether the agent
// still asked the same thing.

// What happened at one idx, in the order the checks run:
//   override          the fork step (idx === fork_step)
//   diverged          the first step whose request no longer matched the parent's
//   replayed          served from the parent, no live call
//   same-request      live in the fork, but sent the same request as the parent
//   different-request live in the fork, with a different request
//   parent-only       the fork stopped before this step
//   fork-only         the parent stopped before this step
function rowKind(idx, parentStep, forkStep, fork) {
  if (!forkStep) return 'parent-only';
  if (!parentStep) return 'fork-only';
  if (idx === fork.fork_step) return 'override';
  if (idx === fork.diverged_at_step) return 'diverged';
  // Read the flag instead of assuming idx < fork_step: a fork that diverged
  // before its fork step went live from there on.
  if (forkStep.replayed) return 'replayed';
  return forkStep.request_hash === parentStep.request_hash ? 'same-request' : 'different-request';
}

export function alignSteps(parent, fork) {
  const parentByIdx = new Map(parent.steps.map((s) => [s.idx, s]));
  const forkByIdx = new Map(fork.steps.map((s) => [s.idx, s]));
  const lastIdx = Math.max(-1, ...parentByIdx.keys(), ...forkByIdx.keys());

  const rows = [];
  for (let idx = 0; idx <= lastIdx; idx++) {
    const parentStep = parentByIdx.get(idx) ?? null;
    const forkStep = forkByIdx.get(idx) ?? null;
    rows.push({ idx, parent: parentStep, fork: forkStep, kind: rowKind(idx, parentStep, forkStep, fork) });
  }
  return rows;
}

// The numbers for the diff page header.
export function diffSummary(rows, fork) {
  return {
    replayed: rows.filter((r) => r.kind === 'replayed').length,
    forkStep: fork.fork_step,
    edit: fork.fork_override?.kind ?? null, // 'response' | 'request' | null (no edit)
    divergedAt: fork.diverged_at_step,
  };
}
