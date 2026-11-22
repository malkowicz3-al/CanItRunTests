import { expect, test } from 'vitest';
import type { RunResult } from '../../shared/api';
import type { Flow } from '../../shared/model';
import { addRequestNode, applyRunEvent, connect, fromTrack, parseStatuses, scriptVars } from './flow';

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
