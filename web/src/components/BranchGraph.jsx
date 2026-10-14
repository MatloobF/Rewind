import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Handle, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { fetchRunTree } from '../api.js';
import { shortId } from '../format.js';
import { forkLabel, treeLayout } from '../tree.js';

const STATUS_DOT = {
  running: 'bg-sky-400',
  success: 'bg-emerald-400',
  failed: 'bg-rose-400',
};

// One run in the graph. Handles are where edges attach: in on the left, out
// on the right. They're hidden: the graph is for looking, not wiring.
function RunNode({ data: { run, current } }) {
  return (
    <div
      className={`w-56 cursor-pointer rounded border px-3 py-2 text-left text-xs ${
        current ? 'border-violet-400 bg-violet-500/15' : 'border-zinc-700 bg-zinc-900 hover:border-zinc-500'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[run.status] ?? 'bg-zinc-500'}`} />
        <span className="truncate font-medium text-zinc-100">{run.name ?? shortId(run.id)}</span>
      </div>
      <div className="mt-1 flex gap-2 text-zinc-500">
        <span className="font-mono">{shortId(run.id)}</span>
        {run.diverged_at_step != null && <span className="text-amber-300">diverged at {run.diverged_at_step}</span>}
      </div>
      {run.parent_run_id && <div className="mt-0.5 truncate text-violet-300">{forkLabel(run)}</div>}
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const NODE_TYPES = { run: RunNode };

// The fork tree around a run. Shown only when the run has a parent or forks.
export default function BranchGraph({ runId }) {
  const navigate = useNavigate();
  const { data: tree } = useQuery({
    queryKey: ['tree', runId],
    queryFn: () => fetchRunTree(runId),
    // Poll while any run in the tree is still recording, like the run list.
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === 'running') ? 2000 : false),
  });

  const layout = useMemo(() => tree && treeLayout(tree.runs, runId), [tree, runId]);
  if (!layout || layout.nodes.length < 2) return null;

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Fork tree ({layout.nodes.length} runs)
      </h2>
      <div
        className="rounded border border-zinc-800 bg-zinc-950"
        style={{ height: Math.min(layout.height + 48, 360) }}
      >
        <ReactFlow
          nodes={layout.nodes}
          edges={layout.edges}
          nodeTypes={NODE_TYPES}
          colorMode="dark"
          onNodeClick={(_, node) => navigate(`/runs/${node.id}`)}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          // Read-only, and the page keeps scrolling when the mouse is over the graph.
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          preventScrolling={false}
        />
      </div>
    </section>
  );
}
