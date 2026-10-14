// Turns the flat run list from GET /api/runs/:id/tree into graph nodes and
// edges for React Flow.
//
// Layout, like `git log --graph`: a depth-first walk from the root gives each
// run its own row, and its fork depth gives the column. A fork therefore sits
// one column right of its parent and below it, next to its siblings.

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 84;

export function treeLayout(runs, currentId) {
  const children = new Map();
  for (const run of runs) {
    const siblings = children.get(run.parent_run_id) ?? [];
    siblings.push(run); // the API returns runs oldest first, so siblings stay in that order
    children.set(run.parent_run_id, siblings);
  }

  const nodes = [];
  const edges = [];
  function place(run, depth) {
    nodes.push({
      id: run.id,
      type: 'run',
      position: { x: depth * COLUMN_WIDTH, y: nodes.length * ROW_HEIGHT },
      data: { run, current: run.id === currentId },
    });
    for (const child of children.get(run.id) ?? []) {
      edges.push({ id: `${run.id}-${child.id}`, source: run.id, target: child.id, type: 'smoothstep' });
      place(child, depth + 1);
    }
  }
  for (const root of children.get(null) ?? []) place(root, 0);

  return { nodes, edges, height: nodes.length * ROW_HEIGHT };
}

// "fork at step 1 · edited response", shown in a fork's node. (On the edges,
// sibling labels overlap where the edges leave the parent.)
export function forkLabel(run) {
  const edit = run.fork_override ? `edited ${run.fork_override.kind}` : 'no edit';
  return `fork at step ${run.fork_step} · ${edit}`;
}
