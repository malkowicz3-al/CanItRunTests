import { expect, test } from 'vitest';
import type { RunResult } from './api';
import { nextNode, nodeOutcome, validateFlow } from './flow';
import type { Flow } from './model';

const result = (status?: number, tests: boolean[] = [], scriptError?: string, error?: RunResult['error']): RunResult => ({
  finalRequest: { method: 'GET', url: 'http://x', headers: {} },
  redirects: [],
  response: status === undefined ? undefined : { status, statusText: '', headers: {}, body: '', size: 0, truncated: false, timings: { dns: 0, tcp: 0, tls: 0, ttfb: 0, transfer: 0, total: 0 } },
  error,
  preScripts: [],
  testScripts: [{ tests: tests.map((passed, i) => ({ name: `t${i}`, passed })), logs: [], error: scriptError }],
  scopes: { runtime: {}, environment: [], collection: [], globals: [] },
});

test('nodeOutcome default 2xx', () => {
  expect(nodeOutcome(result(200), [])).toBe('ok');
  expect(nodeOutcome(result(299), [])).toBe('ok');
  expect(nodeOutcome(result(301), [])).toBe('fail');
  expect(nodeOutcome(result(500), [])).toBe('fail');
});

test('nodeOutcome custom list', () => {
  expect(nodeOutcome(result(404), [404, 410])).toBe('ok');
  expect(nodeOutcome(result(200), [404])).toBe('fail');
});

test('nodeOutcome failed pm.test', () => {
  expect(nodeOutcome(result(200, [true, false]), [])).toBe('fail');
  expect(nodeOutcome(result(200, [true, true]), [])).toBe('ok');
});

test('nodeOutcome script error', () => {
  expect(nodeOutcome(result(200, [], 'boom'), [])).toBe('fail');
});

test('nodeOutcome network error', () => {
  expect(nodeOutcome(result(undefined, [], undefined, { code: 'ECONNREFUSED', message: 'x' }), [])).toBe('fail');
});

const flow = (p: Partial<Flow> = {}): Flow => ({
  id: 'f', name: 'f',
  nodes: [
    { id: 's', type: 'start', position: { x: 0, y: 0 }, data: {} },
    { id: 'a', type: 'request', position: { x: 260, y: 0 }, data: { collectionId: 'c', requestId: 'r', continueWhen: [] } },
    { id: 'b', type: 'request', position: { x: 520, y: 0 }, data: { collectionId: 'c', requestId: 'r', continueWhen: [201] } },
  ],
  edges: [{ id: 'e1', source: 's', sourceHandle: 'ok', target: 'a' }, { id: 'e2', source: 'a', sourceHandle: 'ok', target: 'b' }],
  ...p,
});

test('validateFlow accepts a valid graph with a cycle', () => {
  expect(validateFlow(flow({ maxNodeRuns: 5, edges: [...flow().edges, { id: 'e3', source: 'b', sourceHandle: 'fail', target: 'b' }] }))).toBeUndefined();
});

test('validateFlow two Starts', () => {
  expect(validateFlow(flow({ nodes: [...flow().nodes, { id: 's2', type: 'start', position: { x: 0, y: 0 }, data: {} }] }))).toMatch(/exactly one Start/);
});

test('validateFlow edge to Start', () => {
  expect(validateFlow(flow({ edges: [{ id: 'e', source: 'a', sourceHandle: 'fail', target: 's' }] }))).toMatch(/into Start/);
});

test('validateFlow two edges from one pin', () => {
  expect(validateFlow(flow({ edges: [...flow().edges, { id: 'e3', source: 'a', sourceHandle: 'ok', target: 'a' }] }))).toMatch(/more than one cable/);
});

test('validateFlow edge to missing node', () => {
  expect(validateFlow(flow({ edges: [{ id: 'e', source: 's', sourceHandle: 'ok', target: 'nope' }] }))).toMatch(/missing node/);
});

test('validateFlow bad continueWhen', () => {
  const nodes = flow().nodes.map((n) => (n.type === 'request' ? { ...n, data: { ...n.data, continueWhen: [99] } } : n));
  expect(validateFlow(flow({ nodes }))).toMatch(/continueWhen/);
  expect(validateFlow(flow({ nodes: flow().nodes.map((n) => (n.type === 'request' ? { ...n, data: { ...n.data, continueWhen: [200.5] } } : n)) }))).toMatch(/continueWhen/);
});

test('validateFlow maxNodeRuns out of range', () => {
  expect(validateFlow(flow({ maxNodeRuns: 0 }))).toMatch(/maxNodeRuns/);
  expect(validateFlow(flow({ maxNodeRuns: 10_001 }))).toMatch(/maxNodeRuns/);
  expect(validateFlow(flow({ maxNodeRuns: 10_000 }))).toBeUndefined();
});

test('validateFlow Start with fail handle', () => {
  expect(validateFlow(flow({ edges: [{ id: 'e', source: 's', sourceHandle: 'fail', target: 'a' }] }))).toMatch(/only the ok pin/);
});

test('nextNode undefined when pin has no cable', () => {
  const f = flow();
  expect(nextNode(f, 's', 'ok')?.id).toBe('a');
  expect(nextNode(f, 'a', 'ok')?.id).toBe('b');
  expect(nextNode(f, 'a', 'fail')).toBeUndefined();
  expect(nextNode(f, 'b', 'ok')).toBeUndefined();
});

test('nodeOutcome skipped request is ok', () => {
  expect(nodeOutcome(result(undefined, [], undefined, { code: 'ESKIPPED', message: 'x' }), [])).toBe('ok');
});
