export type Adjacency = {
  nodeEdges: Map<string, Set<string>>;         // nodeId   -> edgeIds touching it
  edgeEnds: Map<string, [string, string]>;     // edgeId   -> [source, target]
  edgePorts: Map<string, string[]>;            // edgeId   -> ["node:port", ...]
  search: Map<string, string>;                 // id       -> lower-cased haystack
  nodeLabels: Map<string, Set<string>>;        // nodeId   -> set of "key=value" labels (exact match)
};

export function emptyAdjacency(): Adjacency {
  return {
    nodeEdges: new Map(),
    edgeEnds: new Map(),
    edgePorts: new Map(),
    search: new Map(),
    nodeLabels: new Map(),
  };
}

export function linkAdjacency(adjacency: Adjacency, id: string, a: string, b: string, ports: string[]): void {
  adjacency.edgeEnds.set(id, [a, b]);
  adjacency.edgePorts.set(id, ports);
  (adjacency.nodeEdges.get(a) ?? adjacency.nodeEdges.set(a, new Set()).get(a)!).add(id);
  (adjacency.nodeEdges.get(b) ?? adjacency.nodeEdges.set(b, new Set()).get(b)!).add(id);
}
