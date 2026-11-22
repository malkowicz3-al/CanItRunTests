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

export interface RunFlowBody {
  environmentId?: Id;
  overrides?: Record<Id, RequestItem>; // unsaved drafts by requestId
}

export interface FlowRunState {
  runId: Id; flowId: Id; status: 'running' | FlowStatus | 'error'; error?: string; startedAt: string;
  currentNodeId?: Id;
  path: Id[]; // executed nodes in order (<= maxNodeRuns), for coloring cables
  nodes: Record<Id, { result: RunResult; outcome: Pin; runs: number }>; // last execution of each node only
}

export type WsMessage =
  | { type: 'flow.started'; flowId: Id; runId: Id }
  | { type: 'flow.node'; flowId: Id; runId: Id; nodeId: Id; phase: 'start' }
  | { type: 'flow.node'; flowId: Id; runId: Id; nodeId: Id; phase: 'end'; outcome: Pin; runs: number; result: RunResult }
  | { type: 'flow.done'; flowId: Id; runId: Id; status: FlowStatus | 'error'; error?: string };
