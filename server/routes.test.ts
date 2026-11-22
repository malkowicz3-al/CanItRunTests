import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Collection, Environment } from '../shared/model';
import { buildWorker } from '../test/buildWorker';
import { startMockServer } from '../test/mockServer';
import type { RunPool } from './runPool';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cirt-routes-'));
const fixture = (name: string) => JSON.parse(readFileSync(path.join('test/fixtures', name), 'utf8'));
let app: FastifyInstance;
let pool: RunPool;
let workerFile: string;
let mock: Awaited<ReturnType<typeof startMockServer>>;
let host: string;

beforeAll(async () => {
  process.env.DATA_DIR = dataDir; // config reads it at import time
  process.env.HOST = 'localhost';
  const [{ registerRoutes }, { createRunPool }] = await Promise.all([import('./routes'), import('./runPool')]);
  [workerFile, mock] = await Promise.all([buildWorker(), startMockServer()]);
  pool = createRunPool(workerFile);
  app = Fastify();
  registerRoutes(app, pool);
  await app.listen({ port: 0, host: '127.0.0.1' }); // the Host guard needs the real port
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

test('import 409 then overwrite', async () => {
  const body = fixture('postman-collection.json');
  const first = await call({ method: 'POST', url: '/api/import', payload: body });
  expect(first.statusCode).toBe(200);
  const { id, kind } = first.json();
  expect(kind).toBe('collection');

  const again = await call({ method: 'POST', url: '/api/import', payload: body });
  expect(again.statusCode).toBe(409);
  expect(again.json()).toEqual({ existingId: id, name: 'Sample API' });

  const over = await call({ method: 'POST', url: '/api/import?overwrite=true', payload: body });
  expect(over.json().id).toBe(id);
  expect((await call({ method: 'GET', url: '/api/collections' })).json()).toEqual([{ id, name: 'Sample API' }]);

  const bad = await call({ method: 'POST', url: '/api/import', payload: { info: { schema: 'x/v2.0.0/' } } });
  expect(bad.statusCode).toBe(400);
});

test('overwrite import keeps request ids for unchanged paths', async () => {
  const body = fixture('postman-collection.json');
  body.info._postman_id = 'keep-ids';
  body.info.name = 'Keep ids';
  const { id } = (await call({ method: 'POST', url: '/api/import', payload: body })).json();
  const before = (await call({ method: 'GET', url: `/api/collections/${id}` })).json() as Collection;

  body.item[0].item[0].name = 'Renamed user';
  await call({ method: 'POST', url: '/api/import?overwrite=true', payload: body });
  const after = (await call({ method: 'GET', url: `/api/collections/${id}` })).json() as Collection;

  const ids = (c: Collection) => c.items.map((it) => [it.name, it.id, it.kind === 'folder' ? it.items.map((x) => x.id) : []] as const);
  const [[, folderBefore, [userBefore, adminBefore]], ...restBefore] = ids(before);
  const [[, folderAfter, [userAfter, adminAfter]], ...restAfter] = ids(after);
  expect(folderAfter).toBe(folderBefore);
  expect(adminAfter).toBe(adminBefore);
  expect(userAfter).not.toBe(userBefore); // the path changed
  expect(restAfter).toEqual(restBefore);
  await call({ method: 'DELETE', url: `/api/collections/${id}` });
});

test('collections CRUD', async () => {
  const c: Collection = { id: 'ignored', name: 'Mine', items: [], auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [] };
  expect((await call({ method: 'PUT', url: '/api/collections/my-col', payload: c })).json().id).toBe('my-col');
  expect((await call({ method: 'GET', url: '/api/collections/my-col' })).json()).toMatchObject({ id: 'my-col', name: 'Mine' });
  expect((await call({ method: 'DELETE', url: '/api/collections/my-col' })).statusCode).toBe(204);
  expect((await call({ method: 'GET', url: '/api/collections/my-col' })).statusCode).toBe(404);
  expect((await call({ method: 'GET', url: '/api/collections/..%2Fx' })).statusCode).toBe(400);
});

test('run persists env changes', async () => {
  const env: Environment = (await call({ method: 'POST', url: '/api/environments', payload: { name: 'dev', values: [{ key: 'base', value: mock.http, enabled: true }] } })).json();
  const c: Collection = {
    id: 'run-col', name: 'Run', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [{ key: 'keep', value: '1', enabled: true }],
    items: [{
      kind: 'request', id: 'r1', name: 'echo', method: 'GET', url: '{{base}}/echo', pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' },
      scripts: { pre: `pm.environment.set('token', 'abc')`, test: `pm.test('ok', () => pm.response.to.have.status(200))` },
    }],
  };
  await call({ method: 'PUT', url: '/api/collections/run-col', payload: c });
  const res = await call({ method: 'POST', url: '/api/run', payload: { collectionId: 'run-col', requestId: 'r1', environmentId: env.id } });
  expect(res.statusCode).toBe(200);
  expect(res.json().testScripts[0].tests).toEqual([{ name: 'ok', passed: true }]);
  const saved: Environment = (await call({ method: 'GET', url: `/api/environments/${env.id}` })).json();
  expect(saved.values).toContainEqual({ key: 'token', value: 'abc', enabled: true });
  expect((await call({ method: 'GET', url: '/api/collections/run-col' })).json().variables).toEqual(c.variables);

  const missing = await call({ method: 'POST', url: '/api/run', payload: { collectionId: 'run-col', requestId: 'nope' } });
  expect(missing.statusCode).toBe(404);
});

test('parallel runs setting different keys both persist', async () => {
  const env: Environment = (await call({ method: 'POST', url: '/api/environments', payload: { name: 'par', values: [{ key: 'base', value: mock.http, enabled: true }] } })).json();
  const item = (id: string, ms: number) => ({
    kind: 'request', id, name: id, method: 'GET', url: `{{base}}/slow?ms=${ms}`, pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' },
    scripts: { pre: '', test: `pm.environment.set('${id}', 'x')` },
  });
  const c = { id: 'par-col', name: 'Par', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [], items: [item('k1', 200), item('k2', 300)] };
  await call({ method: 'PUT', url: '/api/collections/par-col', payload: c });
  const runs = ['k1', 'k2'].map((requestId) => call({ method: 'POST', url: '/api/run', payload: { collectionId: 'par-col', requestId, environmentId: env.id } }));
  // a GUI save during the runs is kept too
  await call({ method: 'PUT', url: `/api/environments/${env.id}`, payload: { ...env, values: [...env.values, { key: 'gui', value: '1', enabled: true }] } });
  for (const r of await Promise.all(runs)) expect(r.statusCode).toBe(200);
  const saved: Environment = (await call({ method: 'GET', url: `/api/environments/${env.id}` })).json();
  expect(saved.values.map((v) => v.key).sort()).toEqual(['base', 'gui', 'k1', 'k2']);
});

test('globals import 409 when non-empty, overwrite replaces', async () => {
  await call({ method: 'PUT', url: '/api/globals', payload: { values: [] } });
  const body = fixture('postman-globals.json');
  expect((await call({ method: 'POST', url: '/api/import', payload: body })).statusCode).toBe(200);
  const again = await call({ method: 'POST', url: '/api/import', payload: body });
  expect(again.statusCode).toBe(409);
  expect(again.json()).toEqual({ existingId: 'globals', name: 'Globals' });
  expect((await call({ method: 'POST', url: '/api/import?overwrite=true', payload: body })).json().kind).toBe('globals');
});

test('corrupt globals.json gives a clear error on run, corrupt env file is skipped in list', async () => {
  writeFileSync(path.join(dataDir, 'globals.json'), '{"values": [');
  const res = await call({ method: 'POST', url: '/api/run', payload: { collectionId: 'run-col', requestId: 'r1' } });
  expect(res.statusCode).toBe(500);
  expect(res.json().message).toMatch(/globals\.json is not valid JSON/);
  await call({ method: 'PUT', url: '/api/globals', payload: { values: [] } });

  writeFileSync(path.join(dataDir, 'environments', 'broken.json'), 'nope');
  const envs = await call({ method: 'GET', url: '/api/environments' });
  expect(envs.statusCode).toBe(200);
  rmSync(path.join(dataDir, 'environments', 'broken.json'));
});

test('rejects text/plain', async () => {
  const res = await call({ method: 'POST', url: '/api/import', payload: '{}', headers: { 'content-type': 'text/plain' } });
  expect(res.statusCode).toBe(415);
});

test('rejects foreign Host', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: `evil.example:${host.split(':')[1]}` } });
  expect(res.statusCode).toBe(403);
  expect((await call({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
});
