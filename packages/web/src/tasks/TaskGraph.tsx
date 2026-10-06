import type { Task } from "@mastermind/core/contracts";
import { Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { Link } from "react-router";
import { taskStatusTone } from "./board.js";
import { graphLayout, nodeSize } from "./graph-layout.js";
import { tasksPath } from "./location.js";
import { StatusWord } from "./StatusWord.js";

type TaskNode = Node<{ task: Task; current: boolean }, "task">;

function TaskNodeView({ data: { task, current } }: NodeProps<TaskNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Link
        className={`graph-node tone-${taskStatusTone(task.status)}`}
        to={tasksPath({ view: "graph", task: task.id })}
        aria-current={current ? "true" : undefined}
        style={nodeSize}
      >
        <span className="task-card-head">
          <code>{task.id}</code>
          <StatusWord status={task.status} />
          {task.held && <span className="held-tag">Held</span>}
        </span>
        <span className="graph-node-title">{task.title}</span>
      </Link>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

const nodeTypes = { task: TaskNodeView };

// React Flow turns off pointer events on nodes that can't be selected or dragged, which would make the links dead.
const linkableNode = { pointerEvents: "all" } as const;

export function TaskGraph({
  tasks,
  selectedId,
}: {
  tasks: readonly Task[];
  selectedId: string | null;
}) {
  const layout = useMemo(() => graphLayout(tasks), [tasks]);
  const nodes = useMemo(
    () =>
      layout.nodes.map(({ task, x, y }): TaskNode => ({
        id: task.id,
        type: "task",
        position: { x, y },
        style: linkableNode,
        data: { task, current: task.id === selectedId },
      })),
    [layout, selectedId],
  );
  const edges = useMemo(
    () =>
      layout.edges.map(({ id, from, to }): Edge => ({
        id,
        source: from,
        target: to,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [layout],
  );

  if (tasks.length === 0) return <p className="muted">No tasks yet.</p>;
  return (
    <div className="task-graph panel" aria-label="Dependency graph" role="figure">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        minZoom={0.2}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
