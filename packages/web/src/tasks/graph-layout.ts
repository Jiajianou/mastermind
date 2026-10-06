import dagre from "@dagrejs/dagre";
import type { GraphLabel, NodeLabel } from "@dagrejs/dagre";
import type { Task } from "@mastermind/core/contracts";

export const nodeSize = { width: 240, height: 76 };

export interface GraphNode {
  task: Task;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function graphLayout(tasks: readonly Task[]): GraphLayout {
  const known = new Set(tasks.map(({ id }) => id));
  const edges = tasks.flatMap((task) =>
    task.deps
      .filter((dep) => known.has(dep))
      .map((dep) => ({ id: `${dep}->${task.id}`, from: dep, to: task.id })),
  );

  const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, object>();
  graph.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 72, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const { id } of tasks) graph.setNode(id, { ...nodeSize });
  for (const { from, to } of edges) graph.setEdge(from, to);
  dagre.layout(graph);

  const nodes = tasks.map((task) => {
    const { x = 0, y = 0 } = graph.node(task.id);
    return { task, x: x - nodeSize.width / 2, y: y - nodeSize.height / 2 };
  });
  return { nodes, edges };
}
