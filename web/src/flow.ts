import type { FlowRunState, WsMessage } from '../../shared/api';
import type { Flow, FlowEdge, FlowNode, Id, Pin, RequestItem } from '../../shared/model';
import { uid } from './util';

export const NODE_GAP = 360; // x spacing of nodes added without a drop position: node width 240 + a visible cable

const SET_RE = /pm\.(environment|collectionVariables|globals|variables)\.set\(\s*(['"`])([^'"`]+)\2/g;

/** Keys a request's own scripts set with a literal name; dynamic keys and folder/collection scripts are not seen. */
export const scriptVars = (scripts: RequestItem['scripts']): string[] =>
  [...new Set([...`${scripts.pre}\n${scripts.test}`.matchAll(SET_RE)].map((m) => m[3]))];

/** "200, 201" -> [200, 201]; empty -> [] (any 2xx); undefined when a part is not a status code. */
export function parseStatuses(text: string): number[] | undefined {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const codes = parts.map(Number);
  return codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599) ? [...new Set(codes)] : undefined;
}

/** Linear flow from the stored Stage 1 track (`cirt.track`), undefined when it has no valid stations. */
export function fromTrack(raw: unknown): Pick<Flow, 'name' | 'nodes' | 'edges'> | undefined {
  const t = raw as { name?: unknown; stations?: unknown } | null;
  if (!t || !Array.isArray(t.stations)) return undefined;
  const stations = (t.stations as ({ id?: unknown; collectionId?: unknown; requestId?: unknown } | null)[])
    .filter((s) => !!s && typeof s.id === 'string' && typeof s.collectionId === 'string' && typeof s.requestId === 'string') as { id: string; collectionId: Id; requestId: Id }[];
  if (!stations.length) return undefined;
  const nodes: FlowNode[] = [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
    ...stations.map((s, i): FlowNode => ({ id: s.id, type: 'request', position: { x: (i + 1) * NODE_GAP, y: 0 }, data: { collectionId: s.collectionId, requestId: s.requestId, continueWhen: [] } })),
  ];
  const edges = nodes.slice(1).map((n, i): FlowEdge => ({ id: uid(), source: nodes[i].id, sourceHandle: 'ok', target: n.id }));
  return { name: typeof t.name === 'string' && t.name.trim() ? t.name : 'Scratch track', nodes, edges };
}

/** Cable from `source`'s pin to `target`; replaces the cable that pin already had (one cable per output pin). */
export function connect(flow: Flow, c: { source: string; sourceHandle?: string | null; target: string }): Flow {
  const sourceHandle = (c.sourceHandle ?? 'ok') as Pin;
  const edges = flow.edges.filter((e) => !(e.source === c.source && e.sourceHandle === sourceHandle));
  return { ...flow, edges: [...edges, { id: uid(), source: c.source, sourceHandle, target: c.target }] };
}

/** Adds a request node at `at` (default: right of the last added node) and wires the last node's OK pin to it when free. */
export function addRequestNode(flow: Flow, collectionId: Id, requestId: Id, at?: { x: number; y: number }): Flow {
  const last = flow.nodes.at(-1);
  const node: FlowNode = { id: uid(), type: 'request', position: at ?? { x: (last?.position.x ?? -NODE_GAP) + NODE_GAP, y: last?.position.y ?? 0 }, data: { collectionId, requestId, continueWhen: [] } };
  const next = { ...flow, nodes: [...flow.nodes, node] };
  return last && !flow.edges.some((e) => e.source === last.id && e.sourceHandle === 'ok') ? connect(next, { source: last.id, sourceHandle: 'ok', target: node.id }) : next;
}

/** Run state of one flow after a /ws event (events of other flows are the caller's to filter). */
export function applyRunEvent(s: FlowRunState | null, m: WsMessage): FlowRunState | null {
  if (m.type === 'flow.started') return { runId: m.runId, flowId: m.flowId, status: 'running', startedAt: new Date().toISOString(), path: [], nodes: {} };
  if (!s || s.runId !== m.runId) return s; // a missed start: the GET after reconnect catches up
  if (m.type === 'flow.done') return { ...s, status: m.status, error: m.error, currentNodeId: undefined };
  if (m.phase === 'start') return { ...s, currentNodeId: m.nodeId, path: [...s.path, m.nodeId] };
  return { ...s, nodes: { ...s.nodes, [m.nodeId]: { result: m.result, outcome: m.outcome, runs: m.runs } } };
}
