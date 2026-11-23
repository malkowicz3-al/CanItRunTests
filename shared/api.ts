import type { Id, Pin, RequestItem, Variable } from './model';

export interface Scopes {
  runtime: Record<string, string>;
  environment: Variable[];
  collection: Variable[];
  globals: Variable[];
}

export interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface Timings { dns: number; tcp: number; tls: number; ttfb: number; transfer: number; total: number } // ms

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: string;
  size: number;
  truncated: boolean; // body cut at the GUI limit
  timings: Timings;
}

export interface HttpError { code: string; message: string } // e.g. 'ETIMEDOUT', 'ECONNREFUSED'

export interface Redirect { status: number; method: string; url: string } // one hop, in order

export interface ScriptResult {
  tests: { name: string; passed: boolean; error?: string }[];
  logs: { level: string; text: string }[];
  nextRequest?: string | null;
  error?: string;
  skipped?: true; // pm.execution.skipRequest() in a pre-script
  ms?: number; // run time incl. its pm.sendRequest calls and timers
}

export interface RunRequestBody {
  collectionId: Id;
  requestId: Id;
  environmentId?: Id;
  request?: RequestItem; // unsaved editor state
}

export interface RunResult {
  finalRequest: PreparedRequest; // last request actually sent
  redirects: Redirect[];
  response?: HttpResponse;
  error?: HttpError;
  preScripts: ScriptResult[];
  testScripts: ScriptResult[];
  scopes: Scopes; // after changes
  nextRequest?: string | null;
}

export interface ImportResult {
  kind: 'collection' | 'environment' | 'globals';
  id?: Id; // absent for globals
  name?: string;
  warnings: string[];
}

export interface ImportConflict { existingId: Id; name: string } // 409 body

export type FlowStatus = 'done' | 'limit' | 'cancelled';

export type RunMode = 'once' | 'iterations' | 'loop';

export interface RunFlowBody {
  environmentId?: Id;
  overrides?: Record<Id, RequestItem>; // unsaved drafts by requestId
  mode?: RunMode; // default 'once'; once + 1 VU is the live run with variable write-back, anything else is a load run without it
  iterations?: number; // mode 'iterations': per VU, 1..1e6, iterations x vus <= 1e7
  vus?: number; // parallel virtual users, 1..200, default 1
}

export type ResultSample = Omit<RunResult, 'scopes'> & { truncated?: true }; // response body, request body and script logs cut at 64 KB each (16 KB in LoadCall samples); truncated: request body or logs were cut

/** One node execution of a load run; seq is unique within the run. GET /api/flows/:id/run/calls returns these, newest first. */
export interface LoadCall { seq: number; vu: number; iteration: number; at: number; status?: number; code?: string; ms: number; outcome: Pin } // vu, iteration: 1-based; at: epoch ms of the start
export interface LoadCalls { calls: LoadCall[]; truncated: boolean; total: number } // total: the node's calls (or failed ones) in the run; truncated: more than the list holds

/** Per-node load statistics; durations are the node's wall time in ms (scripts + HTTP). Helpers in shared/stats.ts. */
export interface NodeStats {
  count: number; ok: number; fail: number;
  sum: number; min: number; max: number;
  hist: Record<number, number>; // log bucket index -> count
  codes: Record<string, number>; // HTTP status or error code -> count
  last?: ResultSample;
  lastError?: ResultSample; // last execution with outcome 'fail'
}

export interface LoadStats {
  mode: RunMode; vus: number; iterations?: number; // iterations: total target (per VU x vus), absent for loop
  iterationsDone: number; elapsedMs: number;
  failedIterations: number; // finished iterations with at least one node outcome 'fail'
  nodes: Record<Id, NodeStats>; // cumulative since the start
}

export interface FlowRunState {
  runId: Id; flowId: Id; status: 'running' | FlowStatus | 'error'; error?: string; startedAt: string;
  currentNodeId?: Id;
  path: Id[]; // executed nodes in order (<= maxNodeRuns), for coloring cables
  nodes: Record<Id, { result: RunResult; outcome: Pin; runs: number }>; // last execution of each node only; empty in load runs
  load?: LoadStats; // load runs only
}

export type WsMessage =
  | { type: 'flow.started'; flowId: Id; runId: Id }
  | { type: 'flow.node'; flowId: Id; runId: Id; nodeId: Id; phase: 'start' }
  | { type: 'flow.node'; flowId: Id; runId: Id; nodeId: Id; phase: 'end'; outcome: Pin; runs: number; result: RunResult }
  // load runs: cumulative stats every 250 ms, the last one right before flow.done is final; no flow.node events
  // a node's last/lastError are sent only when it had new calls since the last flow.stats with its samples (at most once a second): keep the previous ones otherwise
  | { type: 'flow.stats'; flowId: Id; runId: Id; load: LoadStats }
  | { type: 'flow.done'; flowId: Id; runId: Id; status: FlowStatus | 'error'; error?: string };
