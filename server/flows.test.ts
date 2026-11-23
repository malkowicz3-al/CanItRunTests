import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { LoadCalls, WsMessage } from '../shared/api';
import type { Collection, Environment, Flow, RequestItem } from '../shared/model';
import { buildWorker } from '../test/buildWorker';
import { startMockServer } from '../test/mockServer';
import type { RunPool } from './runPool';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cirt-flows-'));
let app: FastifyInstance;
let pool: RunPool;
let workerFile: string;
let mock: Awaited<ReturnType<typeof startMockServer>>;
let host: string;

beforeAll(async () => {
  process.env.DATA_DIR = dataDir; // config reads it at import time
  process.env.HOST = 'localhost';
  const [{ registerRoutes }, { registerFlows }, { registerWs }, { createRunPool }] = await Promise.all([import('./routes'), import('./flows'), import('./ws'), import('./runPool')]);
  [workerFile, mock] = await Promise.all([buildWorker(), startMockServer()]);
  pool = createRunPool(workerFile);
  app = Fastify();
  registerWs(app); // same order as main.ts
  registerRoutes(app, pool);
  registerFlows(app, pool, workerFile);
  await app.listen({ port: 0, host: '127.0.0.1' });
  host = `localhost:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await pool.close();
  await mock.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(path.dirname(workerFile), { recursive: true, force: true });
});

const call = (o: InjectOptions) => app.inject({ ...o, headers: { host, ...o.headers } });
const item = (id: string, url: string, test = ''): RequestItem => ({
  kind: 'request', id, name: id, method: 'GET', url, pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, scripts: { pre: '', test },
});
const linear = (id: string, collectionId: string, requestIds: string[]): Flow => ({
  id, name: id,
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }, ...requestIds.map((requestId, i) => ({ id: `n${i + 1}`, type: 'request' as const, position: { x: 260 * (i + 1), y: 0 }, data: { collectionId, requestId, continueWhen: [] } }))],
  edges: requestIds.map((_, i) => ({ id: `e${i}`, source: i ? `n${i}` : 'start', sourceHandle: 'ok' as const, target: `n${i + 1}` })),
});
const connect = async (origin?: string) => {
  const ws = await app.injectWS('/ws', { headers: { host, ...(origin && { origin }) } });
  const messages: WsMessage[] = [];
  ws.on('message', (d: Buffer) => messages.push(JSON.parse(String(d))));
  const done = (runId: string) => new Promise<WsMessage[]>((resolve) => {
    const check = () => messages.some((m) => m.type === 'flow.done' && m.runId === runId) ? resolve(messages.filter((m) => m.runId === runId)) : setTimeout(check, 10);
    check();
  });
  return { ws, messages, done };
};

test('flows CRUD, POST adds Start, PUT 400 on invalid graph', async () => {
  const created: Flow = (await call({ method: 'POST', url: '/api/flows', payload: { name: 'Mine' } })).json();
  expect(created.nodes).toEqual([{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }]);
  expect((await call({ method: 'GET', url: '/api/flows' })).json()).toContainEqual({ id: created.id, name: 'Mine' });

  const withNode = { ...linear(created.id, 'c', ['r']), name: 'Renamed', extra: 1 };
  (withNode.nodes[1] as unknown as Record<string, unknown>).selected = true;
  const put = await call({ method: 'PUT', url: `/api/flows/${created.id}`, payload: withNode });
  expect(put.statusCode).toBe(200);
  const saved: Flow = (await call({ method: 'GET', url: `/api/flows/${created.id}` })).json();
  expect(saved).toEqual({ ...linear(created.id, 'c', ['r']), name: 'Renamed' });

  const bad = await call({ method: 'PUT', url: `/api/flows/${created.id}`, payload: { ...saved, edges: [...saved.edges, { id: 'x', source: 'n1', sourceHandle: 'ok', target: 'start' }] } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().message).toMatch(/Start/);

  expect((await call({ method: 'DELETE', url: `/api/flows/${created.id}` })).statusCode).toBe(204);
  expect((await call({ method: 'GET', url: `/api/flows/${created.id}` })).statusCode).toBe(404);
});

test('run: WS event order, second run 409, env saved after node 1 although node 2 cancelled, GET run', async () => {
  const env: Environment = (await call({ method: 'POST', url: '/api/environments', payload: { name: 'flow', values: [{ key: 'base', value: mock.http, enabled: true }] } })).json();
  const c: Collection = {
    id: 'flow-col', name: 'Flow', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [],
    items: [item('a', '{{base}}/echo', `pm.environment.set('token', 'abc')`), item('b', '{{base}}/slow?ms=5000')],
  };
  await call({ method: 'PUT', url: '/api/collections/flow-col', payload: c });
  await call({ method: 'PUT', url: '/api/flows/f1', payload: linear('f1', 'flow-col', ['a', 'b']) });
  const { ws, messages, done } = await connect();

  const run = await call({ method: 'POST', url: '/api/flows/f1/run', payload: { environmentId: env.id, mode: 'once', vus: 1 } });
  expect(run.statusCode).toBe(200);
  const { runId } = run.json();
  const second = await call({ method: 'POST', url: '/api/flows/f1/run', payload: {} });
  expect(second.statusCode).toBe(409);
  expect(second.json()).toEqual({ runId, flowId: 'f1' });
  expect((await call({ method: 'DELETE', url: '/api/flows/f1' })).statusCode).toBe(409);

  await new Promise<void>((resolve) => {
    const check = () => messages.some((m) => m.type === 'flow.node' && m.nodeId === 'n2') ? resolve() : setTimeout(check, 10);
    check();
  });
  expect((await call({ method: 'POST', url: '/api/flows/f1/cancel' })).statusCode).toBe(204);
  const events = await done(runId);
  ws.terminate();

  expect(events.map((m) => m.type === 'flow.node' ? `${m.nodeId}:${m.phase}` : m.type)).toEqual(['flow.started', 'n1:start', 'n1:end', 'n2:start', 'n2:end', 'flow.done']);
  expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
  const saved: Environment = (await call({ method: 'GET', url: `/api/environments/${env.id}` })).json();
  expect(saved.values).toContainEqual({ key: 'token', value: 'abc', enabled: true });

  const last = (await call({ method: 'GET', url: '/api/flows/f1/run' })).json();
  expect(last).toMatchObject({ runId, flowId: 'f1', status: 'cancelled', path: ['n1', 'n2'], nodes: { n1: { outcome: 'ok', runs: 1 }, n2: { outcome: 'fail', runs: 1 } } });
  expect(last.nodes.n2.result.error.code).toBe('ECANCELED');
  expect((await call({ method: 'GET', url: '/api/flows/nope/run' })).statusCode).toBe(404);
});

test('/ws rejects a foreign Origin and accepts a missing one', async () => {
  const foreign = await app.injectWS('/ws', { headers: { host, origin: 'http://evil.example' } });
  const code = await new Promise<number>((resolve) => foreign.on('close', resolve));
  expect(code).toBe(1008);
  // the Vite dev server origin is not an exception: its proxy rewrites Origin
  const vite = await app.injectWS('/ws', { headers: { host, origin: 'http://localhost:5173' } });
  expect(await new Promise<number>((resolve) => vite.on('close', resolve))).toBe(1008);

  const same = await connect(`http://${host}`);
  const none = await connect();
  await call({ method: 'PUT', url: '/api/flows/f2', payload: linear('f2', 'flow-col', []) });
  const { runId } = (await call({ method: 'POST', url: '/api/flows/f2/run' })).json();
  for (const c of [same, none]) expect((await c.done(runId)).map((m) => m.type)).toEqual(['flow.started', 'flow.done']);
  same.ws.terminate();
  none.ws.terminate();
});

test('/ws upgrade with a foreign Host is refused', async () => {
  await expect(app.injectWS('/ws', { headers: { host: `evil.example:${host.split(':')[1]}` } })).rejects.toThrow(/403/);
});

test('a failed env save does not skip later saves and ends the run as error', async () => {
  const env: Environment = (await call({ method: 'POST', url: '/api/environments', payload: { name: 'broken', values: [{ key: 'base', value: mock.http, enabled: true }] } })).json();
  const c: Collection = {
    id: 'save-col', name: 'Save', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [],
    items: [item('a', '{{base}}/slow?ms=300', `pm.environment.set('token', 'abc')`), item('b', '{{base}}/echo', `pm.globals.set('afterBroken', 'yes')`)],
  };
  await call({ method: 'PUT', url: '/api/collections/save-col', payload: c });
  await call({ method: 'PUT', url: '/api/flows/f3', payload: linear('f3', 'save-col', ['a', 'b']) });
  const { ws, done } = await connect();
  const { runId } = (await call({ method: 'POST', url: '/api/flows/f3/run', payload: { environmentId: env.id } })).json();
  writeFileSync(path.join(dataDir, 'environments', `${env.id}.json`), '{ broken'); // while node 1 is still waiting
  const events = await done(runId);
  ws.terminate();

  expect(events.at(-1)).toMatchObject({ type: 'flow.done', status: 'error', error: expect.stringMatching(/not valid JSON/) });
  expect((await call({ method: 'GET', url: '/api/globals' })).json().values).toContainEqual({ key: 'afterBroken', value: 'yes', enabled: true });
});

test('load: iterations per VU, stats over WS, no env write-back, report saved, limits 400, calls', async () => {
  const env: Environment = (await call({ method: 'POST', url: '/api/environments', payload: { name: 'load', values: [{ key: 'base', value: mock.http, enabled: true }] } })).json();
  const c: Collection = {
    id: 'load-col', name: 'Load', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [],
    items: [item('a', '{{base}}/echo', `pm.environment.set('token', 'abc')`), item('b', '{{base}}/status?code=500')],
  };
  await call({ method: 'PUT', url: '/api/collections/load-col', payload: c });
  const flow = linear('fl', 'load-col', ['a', 'b']);
  flow.edges.push({ id: 'ef', source: 'n2', sourceHandle: 'fail', target: 'n2' }); // fails until maxNodeRuns ends the iteration
  await call({ method: 'PUT', url: '/api/flows/fl', payload: { ...flow, maxNodeRuns: 3 } });

  for (const payload of [{ vus: 201 }, { vus: 0 }, { mode: 'iterations', iterations: 1_000_001 }, { mode: 'iterations', iterations: 1_000_000, vus: 11 }, { mode: 'x' }, { vus: 1.5 }]) {
    expect((await call({ method: 'POST', url: '/api/flows/fl/run', payload })).statusCode).toBe(400);
  }

  const { ws, done } = await connect();
  const run = await call({ method: 'POST', url: '/api/flows/fl/run', payload: { environmentId: env.id, mode: 'iterations', iterations: 10, vus: 3 } });
  expect(run.statusCode).toBe(200);
  const { runId } = run.json();
  expect((await call({ method: 'POST', url: '/api/flows/fl/run', payload: {} })).statusCode).toBe(409);
  const events = await done(runId);
  ws.terminate();

  expect(events.at(-1)).toMatchObject({ type: 'flow.done', status: 'done' });
  expect(events.some((m) => m.type === 'flow.node')).toBe(false);
  const final = events.findLast((m) => m.type === 'flow.stats');
  expect(final?.type === 'flow.stats' && final.load).toMatchObject({ mode: 'iterations', vus: 3, iterations: 30, iterationsDone: 30, failedIterations: 30, nodes: { n1: { count: 30, ok: 30, fail: 0 }, n2: { count: 60, fail: 60, codes: { 500: 60 } } } });
  const n1 = events.flatMap((m) => (m.type === 'flow.stats' && m.load.nodes.n1 ? [m.load.nodes.n1] : []));
  const withSamples = n1.filter((n) => n.last);
  expect(withSamples.every((n, i) => n.count !== withSamples[i - 1]?.count)).toBe(true); // samples only with new calls
  expect(withSamples.at(-1)?.count).toBe(30); // the final tick carries the latest ones
  const last = (await call({ method: 'GET', url: '/api/flows/fl/run' })).json();
  expect(last.load.nodes.n2.lastError.response.status).toBe(500);
  expect(last.load.nodes.n1.last.scopes).toBeUndefined();
  const saved: Environment = (await call({ method: 'GET', url: `/api/environments/${env.id}` })).json();
  expect(saved.values.map((v) => v.key)).toEqual(['base']);
  const report = JSON.parse(readFileSync(path.join(dataDir, 'reports', `${runId}.json`), 'utf8'));
  expect(report).toMatchObject({ runId, status: 'done', load: { iterationsDone: 30 } });

  const calls = (node: string, filter = 'all') => call({ method: 'GET', url: `/api/flows/fl/run/calls?node=${node}&filter=${filter}` });
  const n1All: LoadCalls = (await calls('n1')).json();
  expect(n1All.calls).toHaveLength(30);
  expect(n1All.truncated).toBe(false);
  expect(n1All.calls.map((x) => x.seq)).toEqual([...n1All.calls.map((x) => x.seq)].sort((a, b) => b - a)); // newest first
  expect(new Set(n1All.calls.map((x) => `${x.vu}/${x.iteration}`)).size).toBe(30); // 3 VUs x 10 iterations each
  expect(n1All.calls[0]).toMatchObject({ status: 200, outcome: 'ok' });
  expect((await calls('n1', 'failed')).json()).toEqual({ calls: [], truncated: false, total: 0 });
  const n2Failed: LoadCalls = (await calls('n2', 'failed')).json();
  expect(n2Failed.calls).toHaveLength(60);
  expect(n2Failed.calls.every((x) => x.outcome === 'fail' && x.status === 500)).toBe(true);
  const one = await call({ method: 'GET', url: `/api/flows/fl/run/calls/${n2Failed.calls[0].seq}` });
  expect(one.json().response.status).toBe(500);
  expect(one.json().scopes).toBeUndefined();
  expect((await call({ method: 'GET', url: '/api/flows/fl/run/calls/999999' })).statusCode).toBe(404);
  expect((await call({ method: 'GET', url: '/api/flows/fl/run/calls/1x' })).statusCode).toBe(400);
  expect((await call({ method: 'GET', url: '/api/flows/fl/run/calls?node=n1&node=n2' })).statusCode).toBe(400);
  expect((await calls('n1', 'x')).statusCode).toBe(400);
  expect((await call({ method: 'GET', url: '/api/flows/fl/run/calls' })).statusCode).toBe(400);
  expect((await call({ method: 'GET', url: '/api/flows/f1/run/calls?node=n1' })).statusCode).toBe(404); // last run of f1 was not a load run
  expect((await call({ method: 'GET', url: '/api/flows/nope/run/calls?node=n1' })).statusCode).toBe(404);
});

test('load: the call list keeps the newest 200 calls per node', async () => {
  const c: Collection = { id: 'ring-col', name: 'Ring', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [], items: [item('a', `${mock.http}/slow?ms=5`)] };
  await call({ method: 'PUT', url: '/api/collections/ring-col', payload: c });
  await call({ method: 'PUT', url: '/api/flows/fring', payload: linear('fring', 'ring-col', ['a']) });
  const { ws, done } = await connect();
  const { runId } = (await call({ method: 'POST', url: '/api/flows/fring/run', payload: { mode: 'iterations', iterations: 210 } })).json();
  await done(runId);
  ws.terminate();
  const list: LoadCalls = (await call({ method: 'GET', url: '/api/flows/fring/run/calls?node=n1' })).json();
  expect(list.calls).toHaveLength(200); // one VU, so one worker sends up to 200 calls per tick
  expect(list.truncated).toBe(true);
  expect(list.calls[0].iteration).toBe(210);
});

test('load: failed list capped at 100 keeps old failures, a newer run replaces the calls', async () => {
  const codes = [...Array(120).fill(500), 200].join(','); // first 120 calls fail, the rest pass
  const c: Collection = { id: 'fail-col', name: 'Fail', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [], items: [item('a', `${mock.http}/seq?key=failcap&codes=${codes}`)] };
  await call({ method: 'PUT', url: '/api/collections/fail-col', payload: c });
  await call({ method: 'PUT', url: '/api/flows/ffail', payload: linear('ffail', 'fail-col', ['a']) });
  const { ws, done } = await connect();
  const { runId } = (await call({ method: 'POST', url: '/api/flows/ffail/run', payload: { mode: 'iterations', iterations: 400 } })).json();
  await done(runId);
  const calls = (filter: string, id = runId) => call({ method: 'GET', url: `/api/flows/ffail/run/calls?node=n1&filter=${filter}&runId=${id}` });
  const failed: LoadCalls = (await calls('failed')).json();
  expect(failed).toMatchObject({ truncated: true, total: 120 });
  expect(failed.calls.map((x) => x.iteration)).toEqual(Array.from({ length: 100 }, (_, i) => 120 - i)); // newest 100, though 280 passing calls came after
  const all: LoadCalls = (await calls('all')).json();
  expect(all.calls).toHaveLength(200);
  expect(all.calls.every((x) => x.outcome === 'ok')).toBe(true);
  const oldSeq = failed.calls[0].seq;
  expect((await call({ method: 'GET', url: `/api/flows/ffail/run/calls/${oldSeq}?runId=${runId}` })).statusCode).toBe(200);

  const second = (await call({ method: 'POST', url: '/api/flows/ffail/run', payload: { mode: 'iterations', iterations: 2 } })).json();
  await done(second.runId);
  ws.terminate();
  expect((await calls('all')).statusCode).toBe(404); // the old runId
  expect((await call({ method: 'GET', url: `/api/flows/ffail/run/calls/${oldSeq}?runId=${runId}` })).statusCode).toBe(404);
  expect((await calls('all', second.runId)).json()).toMatchObject({ total: 2, truncated: false });
  expect((await calls('failed', second.runId)).json().calls).toEqual([]);
  await call({ method: 'DELETE', url: '/api/flows/ffail' });
  expect((await call({ method: 'GET', url: '/api/flows/ffail/run' })).statusCode).toBe(404);
  expect((await calls('all', second.runId)).statusCode).toBe(404);
});

test('load: loop until cancel ends within 2 s', async () => {
  const c: Collection = { id: 'loop-col', name: 'Loop', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [], items: [item('a', `${mock.http}/slow?ms=200`)] };
  await call({ method: 'PUT', url: '/api/collections/loop-col', payload: c });
  await call({ method: 'PUT', url: '/api/flows/floop', payload: linear('floop', 'loop-col', ['a']) });
  const { ws, messages, done } = await connect();
  const { runId } = (await call({ method: 'POST', url: '/api/flows/floop/run', payload: { mode: 'loop', vus: 4 } })).json();
  await new Promise<void>((resolve) => {
    const check = () => messages.some((m) => m.type === 'flow.stats' && m.load.iterationsDone > 0) ? resolve() : setTimeout(check, 10);
    check();
  });
  const t0 = Date.now();
  await call({ method: 'POST', url: '/api/flows/floop/cancel' });
  const events = await done(runId);
  ws.terminate();
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(events.at(-1)).toMatchObject({ type: 'flow.done', status: 'cancelled' });
  const final = events.findLast((m) => m.type === 'flow.stats');
  expect(final?.type === 'flow.stats' && final.load.nodes.n1.fail).toBe(0); // aborted requests are not counted
});
