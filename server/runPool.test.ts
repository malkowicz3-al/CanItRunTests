import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Collection, RequestItem } from '../shared/model';
import { buildWorker } from '../test/buildWorker';
import { startMockServer } from '../test/mockServer';
import type { FlowInput } from './core/flow';
import type { RunInput } from './core/run';
import { createRunPool, type RunPool } from './runPool';
import type { FlowJobEvent } from './worker';

let mock: Awaited<ReturnType<typeof startMockServer>>;
let file: string;
let pool: RunPool;
beforeAll(async () => {
  [mock, file] = await Promise.all([startMockServer(), buildWorker()]);
  pool = createRunPool(file, () => 2000);
});
afterAll(async () => {
  await pool.close();
  await mock.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});

const input = (pre: string, url = `${mock.http}/echo`): RunInput => {
  const r: RequestItem = { kind: 'request', id: 'r', name: 'r', method: 'GET', url, pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, scripts: { pre, test: '' } };
  const collection: Collection = { id: 'c', name: 'c', items: [r], auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [] };
  return { collection, requestId: 'r', scopes: { runtime: {}, environment: [], collection: [], globals: [] } };
};

test('runs job', async () => {
  const out = await pool.run(input(`pm.environment.set('a', '1')`));
  expect(out.result.response!.status).toBe(200);
  expect(out.diff).toEqual({ environment: { set: [{ key: 'a', value: '1', enabled: true }], unset: [] } });
  expect(out.result.scopes.environment).toEqual([{ key: 'a', value: '1', enabled: true }]);
});

test('hang after await killed and respawned', async () => {
  await expect(pool.run(input('await null; while (true) {}'))).rejects.toThrow(/restarted/);
  const out = await pool.run(input(''));
  expect(out.result.response!.status).toBe(200);
  expect(out.diff).toEqual({});
});

test('parallel jobs', async () => {
  const start = Date.now();
  const outs = await Promise.all([300, 100, 200].map((ms) => pool.run(input('', `${mock.http}/slow?ms=${ms}`))));
  expect(Date.now() - start).toBeLessThan(550); // concurrent, not 600 ms in sequence
  expect(outs.map((o) => JSON.parse(o.result.response!.body).url)).toEqual(['/slow?ms=300', '/slow?ms=100', '/slow?ms=200']);
});

test('unawaited failing sendRequest does not kill the worker', async () => {
  const [bad, slow] = await Promise.all([
    pool.run(input(`pm.sendRequest('http://127.0.0.1:1/'); setTimeout(async () => { throw new Error('boom'); }, 0);`)),
    pool.run(input('', `${mock.http}/slow?ms=300`)),
  ]);
  expect(bad.result.preScripts[0].error).toBe('Error: boom');
  expect(slow.result.response!.status).toBe(200);
  expect((await pool.run(input(''))).result.response!.status).toBe(200);
});

test('unknown request rejected before the worker', async () => {
  await expect(pool.run({ ...input(''), requestId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
});

const flowInput = (aUrl: string, aPre = ''): FlowInput => {
  const r = (id: string, url: string, pre = ''): RequestItem => ({ ...input(pre, url).collection.items[0] as RequestItem, id, name: id });
  const collection: Collection = { ...input('').collection, items: [r('a', aUrl, aPre), r('b', `${mock.http}/echo`, `pm.environment.set('b', '1')`)] };
  const node = (id: string, requestId: string) => ({ id, type: 'request' as const, position: { x: 0, y: 0 }, data: { collectionId: 'c', requestId, continueWhen: [] } });
  return {
    flow: {
      id: 'f', name: 'f',
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, data: {} }, node('A', 'a'), node('B', 'b')],
      edges: [{ id: 'e1', source: 's', sourceHandle: 'ok', target: 'A' }, { id: 'e2', source: 'A', sourceHandle: 'ok', target: 'B' }, { id: 'e3', source: 'A', sourceHandle: 'fail', target: 'B' }],
    },
    collections: { c: collection },
    scopes: { runtime: {}, environment: [], globals: [], collections: {} },
    maxNodeRuns: 10,
  };
};

test('flow job emits start/end/done in order', async () => {
  const events: FlowJobEvent[] = [];
  const out = await pool.runFlow(flowInput(`${mock.http}/echo`), (e) => events.push(e)).done;
  expect(out).toEqual({ status: 'done', nodeRuns: 2 });
  expect(events.map((e) => `${e.event}:${e.nodeId}`)).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  expect(events[3]).toMatchObject({ outcome: 'ok', collectionId: 'c', diff: { environment: { set: [{ key: 'b', value: '1', enabled: true }], unset: [] } } });
});

test('cancel before next node', async () => {
  const events: FlowJobEvent[] = [];
  const h = pool.runFlow(flowInput(`${mock.http}/slow?ms=3000`), (e) => { events.push(e); if (e.event === 'start') h.cancel(); });
  const started = Date.now();
  expect(await h.done).toEqual({ status: 'cancelled', nodeRuns: 1 });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(events.map((e) => `${e.event}:${e.nodeId}`)).toEqual(['start:A', 'end:A']);
  expect(events[1]).toMatchObject({ outcome: 'fail', result: { error: { code: 'ECANCELED' } } });
});

test('watchdog kills worker when a node hangs and pool respawns', async () => {
  await expect(pool.runFlow(flowInput(`${mock.http}/echo`, 'await null; while (true) {}'), () => {}).done).rejects.toThrow(/Node A did not finish.*restarted/);
  expect((await pool.run(input(''))).result.response!.status).toBe(200);
});
