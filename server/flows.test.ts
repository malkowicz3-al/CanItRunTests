import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WsMessage } from '../shared/api';
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
  registerFlows(app, pool);
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

  const run = await call({ method: 'POST', url: '/api/flows/f1/run', payload: { environmentId: env.id } });
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
