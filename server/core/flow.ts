import type { FlowStatus, RunResult, Scopes } from '../../shared/api';
import { nextNode, nodeOutcome } from '../../shared/flow';
import type { Collection, Environment, Flow, FlowNode, Id, Pin, RequestItem, Variable } from '../../shared/model';
import { execute } from './http';
import { runRequest, type Send } from './run';

export interface FlowInput {
  flow: Flow;
  collections: Record<Id, Collection>; // only the collections the nodes use
  env?: Environment;
  scopes: { runtime: Record<string, string>; environment: Variable[]; globals: Variable[]; collections: Record<Id, Variable[]> }; // mutated in place
  overrides?: Record<Id, RequestItem>; // unsaved GUI drafts by requestId
  maxNodeRuns: number;
}
export interface FlowHooks {
  signal?: AbortSignal;
  onNodeStart?(node: FlowNode, scopes: Scopes): void;
  onNodeEnd?(node: FlowNode, result: RunResult, outcome: Pin, scopes: Scopes): void;
}

const NEXT_REQUEST_WARNING = 'pm.setNextRequest() is ignored in flows; connect the OK/Fail pins instead.';

/** Walks the graph from Start; a pin without a cable ends the run. No I/O besides the requests themselves. */
export async function runFlow(input: FlowInput, hooks: FlowHooks = {}, send: Send = execute): Promise<{ status: FlowStatus; nodeRuns: number }> {
  const { flow, scopes } = input;
  const start = flow.nodes.find((n) => n.type === 'start');
  let node = start && nextNode(flow, start.id, 'ok');
  let nodeRuns = 0;
  while (node?.type === 'request') {
    if (hooks.signal?.aborted) return { status: 'cancelled', nodeRuns };
    if (nodeRuns >= input.maxNodeRuns) return { status: 'limit', nodeRuns };
    nodeRuns++;
    const { collectionId, requestId, continueWhen } = node.data;
    const s: Scopes = { runtime: scopes.runtime, environment: scopes.environment, globals: scopes.globals, collection: (scopes.collections[collectionId] ??= []) };
    hooks.onNodeStart?.(node, s);
    let result: RunResult;
    try {
      const collection = input.collections[collectionId];
      if (!collection) throw new Error(`Collection ${collectionId} not found`);
      result = await runRequest({ collection, requestId, override: input.overrides?.[requestId], scopes: s, env: input.env, signal: hooks.signal }, send);
    } catch (e) {
      result = { finalRequest: { method: '', url: '', headers: {} }, redirects: [], error: { code: 'EFLOW', message: (e as Error).message }, preScripts: [], testScripts: [], scopes: s };
    }
    if (result.nextRequest !== undefined) [...result.preScripts, ...result.testScripts].at(-1)?.logs.push({ level: 'warn', text: NEXT_REQUEST_WARNING });
    const outcome = nodeOutcome(result, continueWhen);
    hooks.onNodeEnd?.(node, result, outcome, s);
    if (hooks.signal?.aborted) return { status: 'cancelled', nodeRuns }; // a cancel must not follow the Fail pin
    node = nextNode(flow, node.id, outcome);
  }
  return { status: 'done', nodeRuns };
}
