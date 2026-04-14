/**
 * lib/cpm.ts — Critical Path Method
 *
 * Forward pass  → early start / early finish
 * Backward pass → late start / late finish
 * Float         → late start - early start  (zero = critical)
 * Critical path → chain of zero-float tasks from start to finish
 */

export interface CpmNode {
  id: number;
  slug: string;
  title: string;
  duration: number; // days (defaults to 1 if null)
  phase?: string | null;
}

export interface CpmEdge {
  predecessor_id: number;
  successor_id: number;
}

export interface CpmResult {
  nodes: CpmResultNode[];
  critical_path: string[];      // slugs in order
  project_duration: number;     // total days
}

export interface CpmResultNode {
  id: number;
  slug: string;
  title: string;
  phase: string | null;
  duration: number;
  early_start: number;
  early_finish: number;
  late_start: number;
  late_finish: number;
  float_days: number;
  is_critical: boolean;
}

// ── Topological sort (Kahn's algorithm) ───────────────────────────────────────

export function topoSort(nodes: CpmNode[], edges: CpmEdge[]): number[] {
  const inDegree = new Map<number, number>();
  const adj      = new Map<number, number[]>(); // predecessor → successors

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const e of edges) {
    adj.get(e.predecessor_id)!.push(e.successor_id);
    inDegree.set(e.successor_id, (inDegree.get(e.successor_id) ?? 0) + 1);
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const succ of adj.get(cur)!) {
      const newDeg = inDegree.get(succ)! - 1;
      inDegree.set(succ, newDeg);
      if (newDeg === 0) queue.push(succ);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error('Cycle detected in dependency graph — cannot run CPM');
  }

  return order;
}

// ── CPM computation ───────────────────────────────────────────────────────────

export function computeCpm(nodes: CpmNode[], edges: CpmEdge[]): CpmResult {
  if (nodes.length === 0) {
    return { nodes: [], critical_path: [], project_duration: 0 };
  }

  const order = topoSort(nodes, edges);

  const nodeMap = new Map<number, CpmNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // predecessors[id] = list of predecessor ids
  const predecessors = new Map<number, number[]>();
  // successors[id]   = list of successor ids
  const successors   = new Map<number, number[]>();
  for (const n of nodes) {
    predecessors.set(n.id, []);
    successors.set(n.id, []);
  }
  for (const e of edges) {
    predecessors.get(e.successor_id)!.push(e.predecessor_id);
    successors.get(e.predecessor_id)!.push(e.successor_id);
  }

  const duration = (id: number) => Math.max(nodeMap.get(id)!.duration ?? 1, 0);

  // Forward pass ──────────────────────────────────────────────────────────────
  const ES = new Map<number, number>(); // early start
  const EF = new Map<number, number>(); // early finish

  for (const id of order) {
    const preds = predecessors.get(id)!;
    const es = preds.length === 0
      ? 0
      : Math.max(...preds.map(p => EF.get(p)!));
    ES.set(id, es);
    EF.set(id, es + duration(id));
  }

  const projectDuration = Math.max(...[...EF.values()]);

  // Backward pass ─────────────────────────────────────────────────────────────
  const LS = new Map<number, number>(); // late start
  const LF = new Map<number, number>(); // late finish

  for (const id of [...order].reverse()) {
    const succs = successors.get(id)!;
    const lf = succs.length === 0
      ? projectDuration
      : Math.min(...succs.map(s => LS.get(s)!));
    LF.set(id, lf);
    LS.set(id, lf - duration(id));
  }

  // Float & critical ──────────────────────────────────────────────────────────
  const results: CpmResultNode[] = order.map(id => {
    const n   = nodeMap.get(id)!;
    const es  = ES.get(id)!;
    const ef  = EF.get(id)!;
    const ls  = LS.get(id)!;
    const lf  = LF.get(id)!;
    const flt = Math.round((ls - es) * 1000) / 1000; // round fp noise
    return {
      id,
      slug:        n.slug,
      title:       n.title,
      phase:       n.phase ?? null,
      duration:    duration(id),
      early_start: es,
      early_finish: ef,
      late_start:  ls,
      late_finish: lf,
      float_days:  flt,
      is_critical: flt <= 0,
    };
  });

  // Critical path: chain of critical nodes from ES=0 to EF=projectDuration
  const criticalIds = new Set(results.filter(r => r.is_critical).map(r => r.id));
  const slugMap     = new Map(results.map(r => [r.id, r.slug]));

  // Walk from source(s) → sink(s) through critical edges
  const criticalPath: string[] = [];
  let current = results.find(r => r.is_critical && r.early_start === 0);
  const visited = new Set<number>();
  while (current && !visited.has(current.id)) {
    criticalPath.push(current.slug);
    visited.add(current.id);
    const succs = (successors.get(current.id) ?? []).filter(s => criticalIds.has(s));
    current = succs.length > 0 ? results.find(r => r.id === succs[0]) : undefined;
  }

  return {
    nodes: results,
    critical_path: criticalPath,
    project_duration: projectDuration,
  };
}

// ── ASCII DAG ─────────────────────────────────────────────────────────────────

export function asciiDag(nodes: CpmNode[], edges: CpmEdge[], cpmNodes?: CpmResultNode[]): string {
  if (nodes.length === 0) return '(no tasks)';

  const critSet = new Set(cpmNodes?.filter(n => n.is_critical).map(n => n.id) ?? []);
  const order   = topoSort(nodes, edges);
  const nodeMap = new Map<number, CpmNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const successors = new Map<number, number[]>();
  for (const n of nodes) successors.set(n.id, []);
  for (const e of edges) successors.get(e.predecessor_id)!.push(e.successor_id);

  const lines: string[] = [];
  for (const id of order) {
    const n       = nodeMap.get(id)!;
    const marker  = critSet.has(id) ? '★' : '○';
    const succs   = successors.get(id)!;
    const arrow   = succs.length > 0 ? ` → [${succs.map(s => nodeMap.get(s)!.slug).join(', ')}]` : '';
    lines.push(`${marker} ${n.slug}${arrow}`);
  }
  return lines.join('\n');
}

// ── DOT format ────────────────────────────────────────────────────────────────

export function dotGraph(nodes: CpmNode[], edges: CpmEdge[], cpmNodes?: CpmResultNode[]): string {
  const critSet = new Set(cpmNodes?.filter(n => n.is_critical).map(n => n.id) ?? []);
  const lines   = ['digraph crux {', '  rankdir=LR;'];

  for (const n of nodes) {
    const style = critSet.has(n.id) ? ' style=filled fillcolor="#ff6b6b"' : '';
    lines.push(`  "${n.slug}" [label="${n.slug}\\n${n.title}"${style}];`);
  }
  for (const e of edges) {
    const pred = nodes.find(n => n.id === e.predecessor_id)!;
    const succ = nodes.find(n => n.id === e.successor_id)!;
    const style = critSet.has(pred.id) && critSet.has(succ.id) ? ' [color=red penwidth=2]' : '';
    lines.push(`  "${pred.slug}" -> "${succ.slug}"${style};`);
  }

  lines.push('}');
  return lines.join('\n');
}
