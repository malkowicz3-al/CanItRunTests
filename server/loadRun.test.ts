import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Collection, RequestItem } from '../shared/model';
import { buildWorker } from '../test/buildWorker';
import { startMockServer } from '../test/mockServer';
import type { FlowInput } from './core/flow';
import { startLoad, type LoadTotals } from './loadRun';

let mock: Awaited<ReturnType<typeof startMockServer>>;
let file: string;
beforeAll(async () => {
  [mock, file] = await Promise.all([startMockServer(), buildWorker()]);
});
afterAll(async () => {
  await mock.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});

const flowInput = (url: string, pre = ''): FlowInput => {
  const r: RequestItem = { kind: 'request', id: 'a', name: 'a', method: 'GET', url, pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' }, scripts: { pre, test: '' } };
  const collection: Collection = { id: 'c', name: 'c', items: [r], auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [] };
  return {
    flow: {
      id: 'f', name: 'f',
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, data: {} }, { id: 'A', type: 'request', position: { x: 0, y: 0 }, data: { collectionId: 'c', requestId: 'a', continueWhen: [] } }],
      edges: [{ id: 'e1', source: 's', sourceHandle: 'ok', target: 'A' }],
    },
    collections: { c: collection },
    scopes: { runtime: {}, environment: [], globals: [], collections: {} },
    maxNodeRuns: 10,
  };
};

test('every VU runs all iterations and its calls are numbered', async () => {
  const h = startLoad(flowInput(`${mock.http}/echo`), { vus: 5, iterations: 3 }, file, () => {});
  expect(await h.done).toBe('done');
  expect(h.totals.iterations).toBe(15);
  const calls = h.totals.calls.A.all;
  expect(calls.map((c) => `${c.vu}/${c.iteration}`).sort()).toEqual([1, 2, 3, 4, 5].flatMap((v) => [1, 2, 3].map((i) => `${v}/${i}`)).sort());
  expect(new Set(calls.map((c) => c.seq)).size).toBe(15);
  expect(calls[0].sample.response?.status).toBe(200);
});

test('maxDurationMs ends a loop run as limit', async () => {
  const h = startLoad(flowInput(`${mock.http}/slow?ms=50`), { vus: 2, maxDurationMs: 200 }, file, () => {});
  expect(await h.done).toBe('limit');
});

test('a script looping after await stalls the run', async () => {
  const h = startLoad(flowInput(`${mock.http}/echo`, 'await null; while (true) {}'), { vus: 1, stallMs: 300 }, file, () => {});
  await expect(h.done).rejects.toThrow(/stalled/);
});

test('stop while a script blocks ends as cancelled after killMs', async () => {
  const h = startLoad(flowInput(`${mock.http}/echo`, 'await null; while (true) {}'), { vus: 1, killMs: 300 }, file, () => {});
  setTimeout(() => h.stop(), 200);
  const t0 = Date.now();
  expect(await h.done).toBe('cancelled');
  expect(Date.now() - t0).toBeLessThan(1500);
});

test('the final tick carries the newest call as last, though samples are throttled', async () => {
  const h = startLoad(flowInput(`${mock.http}/echo`, 'console.log(String(Math.random()));'), { vus: 1, iterations: 5 }, file, () => {});
  expect(await h.done).toBe('done');
  const logs = (s: { preScripts: { logs: { text: string }[] }[] }) => s.preScripts.flatMap((p) => p.logs).map((l) => l.text);
  const calls = h.totals.calls.A.all;
  expect(logs(h.totals.nodes.A.last!)).toEqual(logs(calls.at(-1)!.sample));
  expect(logs(h.totals.nodes.A.last!)).not.toEqual(logs(calls[0].sample));
});

test('samples cut request body and script logs', async () => {
  const input = flowInput(`${mock.http}/echo`, `console.log('x'.repeat(40000)); console.log('y'.repeat(40000)); console.log('z');`);
  const r = input.collections.c.items[0] as RequestItem;
  r.method = 'POST';
  r.body = { mode: 'raw', raw: 'b'.repeat(70000), language: 'text' };
  let last: LoadTotals | undefined;
  const h = startLoad(input, { vus: 1, iterations: 1 }, file, (t) => { last = t; });
  expect(await h.done).toBe('done');
  const s = last!.nodes.A.last!;
  expect(s.truncated).toBe(true);
  expect(s.finalRequest.body!.length).toBe(64 * 1024);
  expect(s.preScripts.flatMap((p) => p.logs).map((l) => l.text.length)).toEqual([40000, 64 * 1024 - 40000]);
});
