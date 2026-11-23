import { expect, test } from 'vitest';
import type { FlowRunState, LoadStats, RunResult } from '../../shared/api';
import type { Flow, FlowEdge } from '../../shared/model';
import { addRequestNode, applyRunEvent, connect, edgeState, freshResult, fromTrack, parseStatuses, scriptVars } from './flow';

const start: Flow = { id: 'f', name: 'F', nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [] };

test('scriptVars: quotes, backticks, duplicates, dynamic key skipped', () => {
  const pre = `pm.environment.set('token', x); pm.globals.set("user", 1);`;
  const test = 'pm.collectionVariables.set( `bookingId`, id); pm.variables.set(name, 2); pm.environment.set("token", y)';
  expect(scriptVars({ pre, test })).toEqual(['token', 'user', 'bookingId']);
});

test('parseStatuses', () => {
  expect(parseStatuses('200, 201')).toEqual([200, 201]);
  expect(parseStatuses('  ')).toEqual([]);
  expect(parseStatuses('200, abc')).toBeUndefined();
  expect(parseStatuses('99')).toBeUndefined();
});

test('fromTrack: linear Start -> stations every 360 px, invalid stations dropped', () => {
  const f = fromTrack({ name: 'T', stations: [{ id: 'a', collectionId: 'c', requestId: 'r1' }, null, { id: 'x', collectionId: 'c' }, { id: 'b', collectionId: 'c', requestId: 'r2' }] })!;
  expect(f.name).toBe('T');
  expect(f.nodes.map((n) => [n.id, n.position.x])).toEqual([['start', 0], ['a', 360], ['b', 720]]);
  expect(f.edges.map((e) => [e.source, e.sourceHandle, e.target])).toEqual([['start', 'ok', 'a'], ['a', 'ok', 'b']]);
  expect(fromTrack({ name: 'T', stations: [] })).toBeUndefined();
  expect(fromTrack(null)).toBeUndefined();
});

test('addRequestNode auto-connects only a free OK pin', () => {
  const one = addRequestNode(start, 'c', 'r1');
  const a = one.nodes[1];
  expect(a.position).toEqual({ x: 360, y: 0 });
  expect(one.edges).toMatchObject([{ source: 'start', sourceHandle: 'ok', target: a.id }]);
  const taken = connect(one, { source: a.id, sourceHandle: 'ok', target: a.id }); // self-loop on OK
  const two = addRequestNode(taken, 'c', 'r2', { x: 5, y: 6 });
  expect(two.nodes[2].position).toEqual({ x: 5, y: 6 });
  expect(two.edges.filter((e) => e.target === two.nodes[2].id)).toEqual([]);
});

test('connect replaces a cable from the same pin', () => {
  const f = connect(connect(start, { source: 'start', sourceHandle: 'ok', target: 'a' }), { source: 'start', sourceHandle: 'ok', target: 'b' });
  expect(f.edges.map((e) => e.target)).toEqual(['b']);
  expect(connect(f, { source: 'b', sourceHandle: 'fail', target: 'a' }).edges).toHaveLength(2);
});

test('applyRunEvent follows a run and ignores other runs', () => {
  const result = {} as RunResult;
  let s = applyRunEvent(null, { type: 'flow.started', flowId: 'f', runId: 'r' });
  s = applyRunEvent(s, { type: 'flow.node', flowId: 'f', runId: 'r', nodeId: 'a', phase: 'start' });
  expect(s).toMatchObject({ status: 'running', currentNodeId: 'a', path: ['a'] });
  s = applyRunEvent(s, { type: 'flow.node', flowId: 'f', runId: 'r', nodeId: 'a', phase: 'end', outcome: 'ok', runs: 1, result });
  expect(applyRunEvent(s, { type: 'flow.done', flowId: 'f', runId: 'other', status: 'done' })).toBe(s);
  s = applyRunEvent(s, { type: 'flow.done', flowId: 'f', runId: 'r', status: 'done' });
  expect(s).toMatchObject({ status: 'done', currentNodeId: undefined, nodes: { a: { outcome: 'ok', runs: 1 } } });
});

test('applyRunEvent takes cumulative load stats of its run only', () => {
  const load = { mode: 'loop', vus: 2, iterationsDone: 5, failedIterations: 0, elapsedMs: 1000, nodes: { a: { count: 5, ok: 5, fail: 0, sum: 50, min: 5, max: 20, hist: {}, codes: { 200: 5 }, last: {} as RunResult } } } as LoadStats;
  const s = applyRunEvent(null, { type: 'flow.started', flowId: 'f', runId: 'r' });
  expect(applyRunEvent(s, { type: 'flow.stats', flowId: 'f', runId: 'other', load })).toBe(s);
  const next = applyRunEvent(s, { type: 'flow.stats', flowId: 'f', runId: 'r', load });
  expect(next).toMatchObject({ status: 'running', nodes: {}, load: { iterationsDone: 5, nodes: { a: { count: 5 } } } });
  const { last: _, ...noSample } = load.nodes.a;
  const later = applyRunEvent(next, { type: 'flow.stats', flowId: 'f', runId: 'r', load: { ...load, iterationsDone: 9, nodes: { a: noSample } } });
  expect(later?.load?.iterationsDone).toBe(9);
  expect(later?.load?.nodes.a.last).toBe(load.nodes.a.last); // a tick without new calls keeps the sample
});

test('freshResult: bubbles when the run counter grows, not for an old run loaded on open or a re-fetch', () => {
  const r = {} as RunResult;
  const seen = (count: number) => ({ result: r, count, runId: 'a' });
  expect(freshResult(seen(1), seen(2), true, false)).toBe(true);
  expect(freshResult(seen(1), seen(2), false, false)).toBe(true); // node end batched with flow.done
  expect(freshResult(seen(5), { ...seen(5), result: {} as RunResult }, true, false)).toBe(false); // new sample object, no new calls (re-fetch)
  expect(freshResult({}, seen(1), true, false)).toBe(true); // a new run
  expect(freshResult({}, seen(1), false, false)).toBe(false); // fetched when the flow opened
  expect(freshResult(seen(1), { ...seen(1), result: {} as RunResult }, false, true)).toBe(true); // node run alone
  expect(freshResult(seen(1), seen(1), false, true)).toBe(false);
  expect(freshResult({}, { count: 1, runId: 'a' }, true, false)).toBe(false);
});

test('edgeState: once follows the outcome pin, load colors cables with traffic by source health', () => {
  const ok: FlowEdge = { id: 'a', source: 'n1', sourceHandle: 'ok', target: 'n2' };
  const fail: FlowEdge = { id: 'b', source: 'n1', sourceHandle: 'fail', target: 'n3' };
  const first: FlowEdge = { id: 'c', source: 'start', sourceHandle: 'ok', target: 'n1' };
  const once: FlowRunState = { runId: 'r', flowId: 'f', status: 'done', startedAt: '', path: ['n1'], nodes: { n1: { result: {} as RunResult, outcome: 'fail', runs: 1 } } };
  expect([ok, fail, first].map((e) => edgeState(e, once, 'start'))).toEqual([{}, { className: 'edge-stop' }, { className: 'edge-go' }]);
  const stats = (count: number, fail: number) => ({ count, ok: count - fail, fail, sum: 0, min: 0, max: 0, hist: {}, codes: {} });
  const load = (n1: ReturnType<typeof stats>, status: FlowRunState['status'] = 'running'): FlowRunState =>
    ({ ...once, status, path: [], nodes: {}, load: { mode: 'loop', vus: 1, iterationsDone: 0, failedIterations: 0, elapsedMs: 0, nodes: { n1 } } });
  expect([ok, fail, first].map((e) => edgeState(e, load(stats(3, 0)), 'start'))).toEqual([{ className: 'edge-go', animated: true }, {}, { className: 'edge-go', animated: true }]);
  expect([ok, fail].map((e) => edgeState(e, load(stats(3, 1), 'done'), 'start'))).toEqual([{ className: 'edge-stop', animated: false }, { className: 'edge-stop', animated: false }]);
  expect(edgeState(first, load(stats(0, 0)), 'start')).toEqual({});
  expect(edgeState(ok, load(stats(3, 3)), 'start')).toEqual({}); // nothing passed the OK pin
});
