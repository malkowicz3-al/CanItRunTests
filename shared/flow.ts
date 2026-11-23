import type { RunResult } from './api';
import type { Flow, FlowNode, Id, Pin } from './model';

// here and not in server/config.ts because the GUI imports validateFlow too
export const FLOW_MAX_NODE_RUNS_CAP = 10_000;

/** OK = a response with a status from continueWhen (empty = any 2xx), no script error and every pm.test passed. */
export function nodeOutcome(r: RunResult, continueWhen: number[]): Pin {
  const s = r.response?.status;
  const statusOk = s !== undefined && (continueWhen.length ? continueWhen.includes(s) : s >= 200 && s < 300);
  const scriptsOk = [...r.preScripts, ...r.testScripts].every((x) => !x.error && x.tests.every((t) => t.passed));
  if (r.error?.code === 'ESKIPPED') return 'ok'; // pm.execution.skipRequest() is intentional, not a failure
  return !r.error && statusOk && scriptsOk ? 'ok' : 'fail';
}

export function nextNode(flow: Flow, nodeId: Id, pin: Pin): FlowNode | undefined {
  const edge = flow.edges.find((e) => e.source === nodeId && e.sourceHandle === pin);
  return edge && flow.nodes.find((n) => n.id === edge.target);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

/** Error message for an invalid graph, undefined when valid. */
export function validateFlow(x: unknown): string | undefined {
  if (!isObj(x)) return 'Flow must be an object';
  if (!isStr(x.id) || !isStr(x.name)) return 'Flow id and name must be strings';
  if (!Array.isArray(x.nodes) || !Array.isArray(x.edges)) return 'Flow nodes and edges must be arrays';
  if (x.maxNodeRuns !== undefined && !(Number.isInteger(x.maxNodeRuns) && (x.maxNodeRuns as number) >= 1 && (x.maxNodeRuns as number) <= FLOW_MAX_NODE_RUNS_CAP)) {
    return `maxNodeRuns must be an integer from 1 to ${FLOW_MAX_NODE_RUNS_CAP}`;
  }
  const types = new Map<string, string>();
  for (const n of x.nodes as unknown[]) {
    if (!isObj(n) || !isStr(n.id)) return 'Node id must be a string';
    if (types.has(n.id)) return `Duplicate node id ${n.id}`;
    if (!isObj(n.position) || typeof n.position.x !== 'number' || typeof n.position.y !== 'number') return `Node ${n.id} needs a position`;
    if (!isObj(n.data)) return `Node ${n.id} needs data`;
    if (n.type === 'request') {
      const d = n.data;
      if (!isStr(d.collectionId) || !isStr(d.requestId)) return `Node ${n.id} needs collectionId and requestId`;
      if (!Array.isArray(d.continueWhen) || !d.continueWhen.every((s) => Number.isInteger(s) && s >= 100 && s <= 599)) return `Node ${n.id}: continueWhen must be status codes 100-599`;
    } else if (n.type !== 'start') return `Node ${n.id} has unknown type`;
    types.set(n.id, n.type);
  }
  if ([...types.values()].filter((t) => t === 'start').length !== 1) return 'Flow must have exactly one Start node';
  const edgeIds = new Set<string>();
  const pins = new Set<string>();
  for (const e of x.edges as unknown[]) {
    if (!isObj(e) || !isStr(e.id) || !isStr(e.source) || !isStr(e.target)) return 'Edge id, source and target must be strings';
    if (edgeIds.has(e.id)) return `Duplicate edge id ${e.id}`;
    edgeIds.add(e.id);
    if (e.sourceHandle !== 'ok' && e.sourceHandle !== 'fail') return `Edge ${e.id}: sourceHandle must be ok or fail`;
    if (!types.has(e.source) || !types.has(e.target)) return `Edge ${e.id} points to a missing node`;
    if (types.get(e.target) === 'start') return `Edge ${e.id} must not lead into Start`;
    if (types.get(e.source) === 'start' && e.sourceHandle !== 'ok') return 'Start has only the ok pin';
    const pin = `${e.source}\0${e.sourceHandle}`;
    if (pins.has(pin)) return `Pin ${e.sourceHandle} of node ${e.source} has more than one cable`;
    pins.add(pin);
  }
  return undefined;
}
