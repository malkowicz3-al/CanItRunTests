import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FlowRunState, FlowStatus, LoadCall, LoadCalls, LoadStats, RunMode } from '../shared/api';
import { validateFlow } from '../shared/flow';
import type { Collection, Environment, Flow, FlowNode, Globals, Id, RequestItem } from '../shared/model';
import { FLOW_MAX_NODE_RUNS, LOAD_SAMPLE_MS, LOAD_TICK_MS, MAX_ITERATIONS, MAX_TOTAL_ITERATIONS, MAX_VUS, SAMPLES_PER_TICK } from './config';
import type { FlowInput } from './core/flow';
import { startLoad, type LoadTotals } from './loadRun';
import { badRequest, isObj, notFound, objBody, persistDiff, type IdParams } from './routes';
import type { RunPool } from './runPool';
import { list, readJson, remove, writeJson } from './storage';
import { broadcast } from './ws';

// one flow run at a time in the whole app: environment variables are shared and the GUI shows one run
let current: { runId: Id; flowId: Id; cancel(): void } | undefined;
// last run per flow, memory only; load runs also leave reports/<runId>.json
const lastRuns = new Map<Id, FlowRunState>();
// per-call lists of the newest load run (one run at a time), memory only (not in the report)
let lastCalls: { runId: Id; flowId: Id; totals: LoadTotals } | undefined;

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

export function registerFlows(app: FastifyInstance, pool: RunPool, workerFile = path.join(__dirname, 'worker.cjs')): void {
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
    lastRuns.delete(req.params.id);
    if (lastCalls?.flowId === req.params.id) lastCalls = undefined;
    return reply.code(204).send();
  });

  app.get<IdParams>('/api/flows/:id/run', async (req) => lastRuns.get(req.params.id) ?? Promise.reject(notFound('Flow run')));
  // seq is unique only within a run, so a given runId must be the kept one
  const loadCalls = (id: Id, runId: unknown) => {
    if (runId !== undefined && typeof runId !== 'string') throw badRequest('runId must be a string');
    if (lastCalls?.flowId !== id || (runId !== undefined && runId !== lastCalls.runId)) throw notFound('Load run');
    return lastCalls.totals;
  };
  app.get<IdParams & { Querystring: { node?: unknown; filter?: unknown; runId?: unknown } }>('/api/flows/:id/run/calls', async (req): Promise<LoadCalls> => {
    const { node, filter = 'all' } = req.query;
    if (!node) throw badRequest('node is required');
    if (typeof node !== 'string') throw badRequest('node must be a string');
    if (filter !== 'all' && filter !== 'failed') throw badRequest("filter must be 'all' or 'failed'");
    const t = loadCalls(req.params.id, req.query.runId);
    const kept = t.calls[node]?.[filter] ?? [];
    const seen = (filter === 'all' ? t.nodes[node]?.count : t.nodes[node]?.fail) ?? 0;
    return { calls: kept.map(({ sample: _, ...c }): LoadCall => c).reverse(), truncated: seen > kept.length, total: seen };
  });
  app.get<{ Params: { id: string; seq: string }; Querystring: { runId?: unknown } }>('/api/flows/:id/run/calls/:seq', async (req) => {
    if (!/^\d+$/.test(req.params.seq)) throw badRequest('seq must be a whole number');
    const t = loadCalls(req.params.id, req.query.runId);
    const seq = Number(req.params.seq);
    for (const { all, failed } of Object.values(t.calls)) {
      const c = all.find((x) => x.seq === seq) ?? failed.find((x) => x.seq === seq);
      if (c) return c.sample;
    }
    throw notFound('Call');
  });
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
    const mode = (b.mode ?? 'once') as RunMode;
    if (!['once', 'iterations', 'loop'].includes(mode)) throw badRequest("mode must be 'once', 'iterations' or 'loop'");
    const int = (x: unknown, max: number, name: string) => {
      if (x === undefined) return 1;
      if (!Number.isInteger(x) || (x as number) < 1 || (x as number) > max) throw badRequest(`${name} must be an integer from 1 to ${max}`);
      return x as number;
    };
    const vus = int(b.vus, MAX_VUS, 'vus');
    const iterations = mode === 'loop' ? undefined : mode === 'once' ? 1 : int(b.iterations, MAX_ITERATIONS, 'iterations'); // per VU
    if (iterations !== undefined && iterations * vus > MAX_TOTAL_ITERATIONS) throw badRequest(`iterations x vus must be at most ${MAX_TOTAL_ITERATIONS}`);
    const load = mode !== 'once' || vus > 1;
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
    if (lastCalls?.flowId === flowId) lastCalls = undefined;
    const input: FlowInput = {
      flow, collections, env, overrides: b.overrides as Record<Id, RequestItem> | undefined,
      maxNodeRuns: flow.maxNodeRuns ?? FLOW_MAX_NODE_RUNS,
      scopes: { runtime: {}, environment: env?.values ?? [], globals: globals.values, collections: Object.fromEntries(Object.values(collections).map((c) => [c.id, c.variables])) },
    };
    let run: { done: Promise<FlowStatus>; cancel(): void };
    if (load) {
      // no variable write-back: N parallel copies of a token have no single result to save
      const stats: LoadStats = (state.load = { mode, vus, iterations: iterations && iterations * vus, iterationsDone: 0, failedIterations: 0, elapsedMs: 0, nodes: {} });
      const started = Date.now();
      const sent: Record<Id, { count: number; at: number }> = {}; // node count and time of the last broadcast that carried its samples
      const h = startLoad(input, { vus, iterations }, workerFile, (t, final) => {
        const now = Date.now();
        Object.assign(stats, { iterationsDone: t.iterations, failedIterations: t.failedIterations, elapsedMs: now - started, nodes: t.nodes });
        // samples (up to 64 KB each) only for nodes with new calls, at most every LOAD_SAMPLE_MS but always in the final tick;
        // the client keeps the previous ones, the GET has them all
        // and at most SAMPLES_PER_TICK nodes per tick, oldest first, so big samples of many nodes don't land in one message
        let budget = final ? Infinity : SAMPLES_PER_TICK;
        const entries = Object.entries(t.nodes).sort(([a], [b]) => (sent[a]?.at ?? 0) - (sent[b]?.at ?? 0));
        const nodes = Object.fromEntries(entries.map(([id, { last, lastError, ...s }]) => {
          const p = sent[id];
          // final always resends: the workers' samples lag their counts by up to LOAD_SAMPLE_MS
          if (p && !final && (p.count === s.count || now - p.at < LOAD_SAMPLE_MS - LOAD_TICK_MS / 2)) return [id, s];
          if (budget <= 0) return [id, s];
          budget--;
          sent[id] = { count: s.count, at: now };
          return [id, { ...s, last, lastError }];
        }));
        broadcast({ type: 'flow.stats', flowId, runId, load: { ...stats, nodes } });
      });
      lastCalls = { runId, flowId, totals: h.totals };
      run = { done: h.done, cancel: h.stop };
    } else {
      let saved = Promise.resolve();
      const handle = pool.runFlow(input, (e) => {
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
      run = { done: handle.done.then((d) => d.status).finally(() => saved), cancel: handle.cancel };
    }
    current = { runId, flowId, cancel: run.cancel };
    broadcast({ type: 'flow.started', flowId, runId });

    void (async () => {
      let status: FlowStatus | 'error';
      try {
        status = await run.done;
      } catch (err) {
        status = 'error';
        state.error = (err as Error).message;
      }
      if (state.error) status = 'error';
      state.status = status;
      state.currentNodeId = undefined;
      if (state.load) {
        try {
          await writeJson(`reports/${runId}.json`, state);
        } catch (err) {
          state.status = status = 'error';
          state.error ??= `Report not saved: ${(err as Error).message}`;
        }
      }
      current = undefined;
      broadcast({ type: 'flow.done', flowId, runId, status, error: state.error });
    })();
    return { runId };
  });
}
