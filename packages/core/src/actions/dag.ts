export interface GraphNode {
  id: string;
  deps: readonly string[];
}

export type GraphIssue =
  | { kind: "duplicate-id"; taskId: string }
  | { kind: "existing-id"; taskId: string }
  | { kind: "unknown-dep"; taskId: string; dep: string }
  | { kind: "cycle"; cycle: readonly string[] };

export function describeGraphIssue(issue: GraphIssue): string {
  switch (issue.kind) {
    case "duplicate-id":
      return `task id "${issue.taskId}" is used more than once`;
    case "existing-id":
      return `task "${issue.taskId}" already exists`;
    case "unknown-dep":
      return `task "${issue.taskId}" depends on "${issue.dep}", which does not exist`;
    case "cycle":
      return `dependency cycle: ${issue.cycle.join(" → ")} (each task depends on the next)`;
  }
}

export function findGraphIssues(
  batch: readonly GraphNode[],
  existing: readonly GraphNode[] = [],
): GraphIssue[] {
  const existingIds = new Set(existing.map((node) => node.id));
  const batchIds = batch.map((node) => node.id);
  const known = new Set([...existingIds, ...batchIds]);
  return [
    ...findDuplicates(batchIds).map((taskId): GraphIssue => ({ kind: "duplicate-id", taskId })),
    ...unique(batchIds)
      .filter((id) => existingIds.has(id))
      .map((taskId): GraphIssue => ({ kind: "existing-id", taskId })),
    ...batch.flatMap((node) =>
      unique(node.deps)
        .filter((dep) => !known.has(dep))
        .map((dep): GraphIssue => ({ kind: "unknown-dep", taskId: node.id, dep })),
    ),
    ...findCycles(batch, existing).map((cycle): GraphIssue => ({ kind: "cycle", cycle })),
  ];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function findDuplicates(ids: readonly string[]): string[] {
  return unique(ids.filter((id, index) => ids.indexOf(id) !== index));
}

function buildEdges(nodes: readonly GraphNode[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const node of nodes)
    edges.set(node.id, unique([...(edges.get(node.id) ?? []), ...node.deps]));
  for (const [id, deps] of edges)
    edges.set(
      id,
      deps.filter((dep) => edges.has(dep)),
    );
  return edges;
}

function findCycles(batch: readonly GraphNode[], existing: readonly GraphNode[]): string[][] {
  const edges = buildEdges([...existing, ...batch]);
  const batchOrder = unique(batch.map((node) => node.id));
  const components = stronglyConnectedComponents(edges);
  const cycles: string[][] = [];
  for (const start of batchOrder) {
    const component = components.get(start);
    if (component === undefined) continue;
    const isFirstInComponent = batchOrder.find((id) => component.has(id)) === start;
    if (!isFirstInComponent) continue;
    const cycle = shortestCycleThrough(start, component, edges);
    if (cycle !== null) cycles.push(cycle);
  }
  return cycles;
}

function stronglyConnectedComponents(
  edges: ReadonlyMap<string, readonly string[]>,
): Map<string, ReadonlySet<string>> {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const componentOf = new Map<string, ReadonlySet<string>>();

  function visit(id: string): void {
    const order = index.size;
    index.set(id, order);
    lowLink.set(id, order);
    stack.push(id);
    onStack.add(id);
    for (const dep of edges.get(id) ?? []) {
      if (!index.has(dep)) {
        visit(dep);
        lowLink.set(id, Math.min(lowLink.get(id) ?? 0, lowLink.get(dep) ?? 0));
      } else if (onStack.has(dep)) {
        lowLink.set(id, Math.min(lowLink.get(id) ?? 0, index.get(dep) ?? 0));
      }
    }
    if (lowLink.get(id) !== index.get(id)) return;
    const component = new Set<string>();
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.add(member);
    } while (member !== id);
    for (const memberId of component) componentOf.set(memberId, component);
  }

  for (const id of edges.keys()) if (!index.has(id)) visit(id);
  return componentOf;
}

function shortestCycleThrough(
  start: string,
  component: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const cameFrom = new Map<string, string>();
  const queue = [start];
  for (const id of queue) {
    for (const dep of edges.get(id) ?? []) {
      if (!component.has(dep)) continue;
      if (dep === start) return [...pathTo(id, cameFrom, start), start];
      if (cameFrom.has(dep)) continue;
      cameFrom.set(dep, id);
      queue.push(dep);
    }
  }
  return null;
}

function pathTo(id: string, cameFrom: ReadonlyMap<string, string>, start: string): string[] {
  const path = [id];
  for (let current = id; current !== start;) {
    const previous = cameFrom.get(current);
    if (previous === undefined) break;
    path.unshift(previous);
    current = previous;
  }
  return path;
}
