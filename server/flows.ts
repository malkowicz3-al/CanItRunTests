import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FlowRunState, FlowStatus } from '../shared/api';
import { validateFlow } from '../shared/flow';
import type { Collection, Environment, Flow, FlowNode, Globals, Id, RequestItem } from '../shared/model';
import { FLOW_MAX_NODE_RUNS } from './config';
import { badRequest, isObj, notFound, objBody, persistDiff, type IdParams } from './routes';
import type { RunPool } from './runPool';
import { list, readJson, remove, writeJson } from './storage';
import { broadcast } from './ws';

// one flow run at a time in the whole app: environment variables are shared and the GUI shows one run
let current: { runId: Id; flowId: Id; cancel(): void } | undefined;
// last run per flow, memory only (reports come in stage 3)
const lastRuns = new Map<Id, FlowRunState>();

/** Validates and keeps only the fields of the type (drops React Flow's selected, measured, ...). */
function cleanFlow(x: unknown): Flow {
  const err = validateFlow(x);
  if (err) throw badRequest(err);
  const f = x as Flow;
  return {
    id: f.id, name: f.name, maxNodeRuns: f.maxNodeRuns,
    nodes: f.nodes.map((n): FlowNode => {
      const position = { x: n.position.x, y: n.position.y };
      if (n.type === 'start') return { id: n.id, type: n.type, position, data: {} };
      const { collectionId, requestId, continueWhen } = n.data;
      return { id: n.id, type: n.type, position, data: { collectionId, requestId, continueWhen } };
    }),
    edges: f.edges.map(({ id, source, sourceHandle, target }) => ({ id, source, sourceHandle, target })),
  };
}

const readFlow = async (id: string) => (await readJson<Flow>(`flows/${id}.json`)) ?? Promise.reject(notFound('Flow'));

export function registerFlows(app: FastifyInstance, pool: RunPool): void {
  app.get('/api/flows', async () => (await list<Flow>('flows')).map(({ id, name }) => ({ id, name })));
  app.post('/api/flows', async (req) => {
    const f = cleanFlow({ name: 'New flow', nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [], ...objBody(req.body ?? {}), id: randomUUID() });
    await writeJson(`flows/${f.id}.json`, f);
    return f;
  });
  app.get<IdParams>('/api/flows/:id', async (req) => readFlow(req.params.id));
  app.put<IdParams>('/api/flows/:id', async (req) => {
    const f = cleanFlow({ ...objBody(req.body), id: req.params.id });
    await writeJson(`flows/${f.id}.json`, f);
    return f;
  });
  app.delete<IdParams>('/api/flows/:id', async (req, reply) => {
    if (current?.flowId === req.params.id) return reply.code(409).send({ runId: current.runId, flowId: current.flowId });
    await remove(`flows/${req.params.id}.json`);
    return reply.code(204).send();
  });

  app.get<IdParams>('/api/flows/:id/run', async (req) => lastRuns.get(req.params.id) ?? Promise.reject(notFound('Flow run')));
  app.post<IdParams>('/api/flows/:id/cancel', async (req, reply) => {
    if (current?.flowId === req.params.id) current.cancel();
    return reply.code(204).send();
  });

  app.post<IdParams>('/api/flows/:id/run', async (req, reply) => {
    const busy = () => current && reply.code(409).send({ runId: current.runId, flowId: current.flowId });
    if (current) return busy();
    const b = objBody(req.body ?? {});
    if (b.environmentId !== undefined && typeof b.environmentId !== 'string') throw badRequest('environmentId must be a string');
    if (b.overrides !== undefined && !(isObj(b.overrides) && Object.values(b.overrides).every((r) => isObj(r) && r.kind === 'request'))) throw badRequest('overrides must map request ids to request items');
    const flow = await readFlow(req.params.id);
    const env = b.environmentId === undefined ? undefined : await readJson<Environment>(`environments/${b.environmentId}.json`);
    if (b.environmentId !== undefined && !env) throw notFound('Environment');
    const globals = (await readJson<Globals>('globals.json')) ?? { values: [] };
    const collections: Record<Id, Collection> = {};
    for (const n of flow.nodes) {
      if (n.type !== 'request' || n.data.collectionId in collections) continue;
      const c = await readJson<Collection>(`collections/${n.data.collectionId}.json`);
      if (c) collections[c.id] = c; // a missing collection makes the node go Fail in the engine
    }
    if (current) return busy(); // another run started while we were reading files

    const runId = randomUUID();
    const flowId = flow.id;
    const state: FlowRunState = { runId, flowId, status: 'running', startedAt: new Date().toISOString(), path: [], nodes: {} };
    lastRuns.set(flowId, state);
    let saved = Promise.resolve();
    const handle = pool.runFlow({
      flow, collections, env, overrides: b.overrides as Record<Id, RequestItem> | undefined,
      maxNodeRuns: flow.maxNodeRuns ?? FLOW_MAX_NODE_RUNS,
      scopes: { runtime: {}, environment: env?.values ?? [], globals: globals.values, collections: Object.fromEntries(Object.values(collections).map((c) => [c.id, c.variables])) },
    }, (e) => {
      if (e.event === 'start') {
        state.currentNodeId = e.nodeId;
        state.path.push(e.nodeId);
        return broadcast({ type: 'flow.node', flowId, runId, nodeId: e.nodeId, phase: 'start' });
      }
      const runs = (state.nodes[e.nodeId]?.runs ?? 0) + 1;
      state.nodes[e.nodeId] = { result: e.result, outcome: e.outcome, runs };
      broadcast({ type: 'flow.node', flowId, runId, nodeId: e.nodeId, phase: 'end', outcome: e.outcome, runs, result: e.result });
      // each node's variable changes are saved right away, so a token survives a later cancel, crash or limit
      // one failed save must not skip the later ones; the run ends as 'error'
      saved = saved.then(() => persistDiff(e.diff, env?.id, e.collectionId)).catch((err) => { state.error ??= (err as Error).message; });
    });
    current = { runId, flowId, cancel: handle.cancel };
    broadcast({ type: 'flow.started', flowId, runId });

    void (async () => {
      let status: FlowStatus | 'error';
      try {
        status = (await handle.done).status;
        await saved;
      } catch (err) {
        await saved;
        status = 'error';
        state.error = (err as Error).message;
      }
      if (state.error) status = 'error';
      state.status = status;
      state.currentNodeId = undefined;
      current = undefined;
      broadcast({ type: 'flow.done', flowId, runId, status, error: state.error });
    })();
    return { runId };
  });
}
