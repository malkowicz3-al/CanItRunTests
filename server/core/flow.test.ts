import { afterAll, beforeAll, expect, test } from 'vitest';
import type { RunResult } from '../../shared/api';
import type { Collection, Flow, FlowEdge, FlowNode, Pin, RequestItem } from '../../shared/model';
import { startMockServer } from '../../test/mockServer';
import { runFlow, type FlowInput } from './flow';

let mock: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => { mock = await startMockServer(); });
afterAll(() => mock.close());

const req = (id: string, url: string, scripts: Partial<RequestItem['scripts']> = {}, headers: RequestItem['headers'] = []): RequestItem => ({
  kind: 'request', id, name: id, method: 'GET', url, pathVariables: [], headers, body: { mode: 'none' }, auth: { type: 'none' }, scripts: { pre: '', test: '', ...scripts },
});
const col = (id: string, items: RequestItem[]): Collection => ({ id, name: id, items, auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [] });
const node = (id: string, requestId: string, collectionId = 'c'): FlowNode => ({ id, type: 'request', position: { x: 0, y: 0 }, data: { collectionId, requestId, continueWhen: [] } });
const edge = (source: string, sourceHandle: Pin, target: string): FlowEdge => ({ id: `${source}-${sourceHandle}`, source, sourceHandle, target });
const flow = (nodes: FlowNode[], edges: FlowEdge[]): Flow => ({ id: 'f', name: 'f', nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, data: {} }, ...nodes], edges });
const input = (f: Flow, collections: Collection[], p: Partial<FlowInput> = {}): FlowInput => ({
  flow: f, collections: Object.fromEntries(collections.map((c) => [c.id, c])),
  scopes: { runtime: {}, environment: [{ key: 'base', value: mock.http, enabled: true }], globals: [], collections: {} }, maxNodeRuns: 100, ...p,
});
const record = () => {
  const ends: { id: string; outcome: Pin; result: RunResult }[] = [];
  return { ends, onNodeEnd: (n: FlowNode, result: RunResult, outcome: Pin) => { ends.push({ id: n.id, outcome, result }); } };
};

test('linear run passes token A→B', async () => {
  const a = req('a', '{{base}}/echo', { test: `pm.environment.set('token', 'T-1')` });
  const b = req('b', '{{base}}/echo', {}, [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }]);
  const h = record();
  const out = await runFlow(input(flow([node('A', 'a'), node('B', 'b')], [edge('s', 'ok', 'A'), edge('A', 'ok', 'B')]), [col('c', [a, b])]), h);
  expect(out).toEqual({ status: 'done', nodeRuns: 2 });
  expect(h.ends.map((e) => [e.id, e.outcome])).toEqual([['A', 'ok'], ['B', 'ok']]);
  expect(JSON.parse(h.ends[1].result.response!.body).headers.authorization).toBe('Bearer T-1');
});

test('fail branch on 500', async () => {
  const h = record();
  const f = flow([node('A', 'a'), node('F', 'b')], [edge('s', 'ok', 'A'), edge('A', 'fail', 'F')]);
  const out = await runFlow(input(f, [col('c', [req('a', '{{base}}/status?code=500'), req('b', '{{base}}/echo')])]), h);
  expect(out).toEqual({ status: 'done', nodeRuns: 2 });
  expect(h.ends.map((e) => [e.id, e.outcome])).toEqual([['A', 'fail'], ['F', 'ok']]);
});

test('fail branch on ECONNREFUSED', async () => {
  const h = record();
  const f = flow([node('A', 'a'), node('F', 'b')], [edge('s', 'ok', 'A'), edge('A', 'fail', 'F')]);
  await runFlow(input(f, [col('c', [req('a', 'http://127.0.0.1:1/x'), req('b', '{{base}}/echo')])]), h);
  expect(h.ends[0].result.error!.code).toBe('ECONNREFUSED');
  expect(h.ends.map((e) => [e.id, e.outcome])).toEqual([['A', 'fail'], ['F', 'ok']]);
});

test('retry cycle 500,500,200 done after 3 runs', async () => {
  const h = record();
  const f = flow([node('A', 'a')], [edge('s', 'ok', 'A'), edge('A', 'fail', 'A')]);
  const out = await runFlow(input(f, [col('c', [req('a', `{{base}}/seq?key=${Math.random()}&codes=500,500,200`)])]), h);
  expect(out).toEqual({ status: 'done', nodeRuns: 3 });
  expect(h.ends.map((e) => e.outcome)).toEqual(['fail', 'fail', 'ok']);
});

test('self-loop limit stops at maxNodeRuns=5', async () => {
  const h = record();
  const f = flow([node('A', 'a')], [edge('s', 'ok', 'A'), edge('A', 'fail', 'A')]);
  const out = await runFlow(input(f, [col('c', [req('a', '{{base}}/status?code=500')])], { maxNodeRuns: 5 }), h);
  expect(out).toEqual({ status: 'limit', nodeRuns: 5 });
  expect(h.ends).toHaveLength(5);
});

test('cancel returns cancelled with ECANCELED', async () => {
  const h = record();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const f = flow([node('A', 'a'), node('B', 'b')], [edge('s', 'ok', 'A'), edge('A', 'fail', 'B'), edge('A', 'ok', 'B')]);
  const started = Date.now();
  const out = await runFlow(input(f, [col('c', [req('a', '{{base}}/slow?ms=3000'), req('b', '{{base}}/echo')])]), { ...h, signal: ac.signal });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(out).toEqual({ status: 'cancelled', nodeRuns: 1 });
  expect(h.ends[0].result.error!.code).toBe('ECANCELED');
});

test('setNextRequest ignored with warning', async () => {
  const h = record();
  const a = req('a', '{{base}}/echo', { test: `pm.setNextRequest('x')` });
  const f = flow([node('A', 'a'), node('B', 'b')], [edge('s', 'ok', 'A'), edge('A', 'ok', 'B')]);
  const out = await runFlow(input(f, [col('c', [a, req('b', '{{base}}/echo')])]), h);
  expect(out.nodeRuns).toBe(2);
  expect(h.ends[0].result.nextRequest).toBe('x');
  expect(h.ends[0].result.testScripts[0].logs).toContainEqual({ level: 'warn', text: expect.stringMatching(/setNextRequest\(\) is ignored/) });
});

test('missing request goes via fail', async () => {
  const h = record();
  const f = flow([node('A', 'gone'), node('F', 'b')], [edge('s', 'ok', 'A'), edge('A', 'fail', 'F')]);
  const out = await runFlow(input(f, [col('c', [req('b', '{{base}}/echo')])]), h);
  expect(out).toEqual({ status: 'done', nodeRuns: 2 });
  expect(h.ends[0]).toMatchObject({ id: 'A', outcome: 'fail', result: { error: { code: 'EFLOW' } } });
});

test('two collections keep separate variables', async () => {
  const h = record();
  const a = req('a', '{{base}}/echo', { test: `pm.collectionVariables.set('v', 'one')` });
  const b = req('b', '{{base}}/echo?v={{v}}', { test: `pm.collectionVariables.set('w', 'two')` });
  const f = flow([node('A', 'a', 'c1'), node('B', 'b', 'c2')], [edge('s', 'ok', 'A'), edge('A', 'ok', 'B')]);
  const i = input(f, [col('c1', [a]), col('c2', [b])]);
  await runFlow(i, h);
  expect(JSON.parse(h.ends[1].result.response!.body).url).toBe('/echo?v={{v}}');
  expect(i.scopes.collections).toEqual({ c1: [{ key: 'v', value: 'one', enabled: true }], c2: [{ key: 'w', value: 'two', enabled: true }] });
});
