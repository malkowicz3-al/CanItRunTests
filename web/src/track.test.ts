import { expect, test, vi } from 'vitest';
import type { RunResult } from '../../shared/api';
import type { Collection, RequestItem } from '../../shared/model';
import { createRunLock, libraryGroups, loadTrack, treeRows, moveItem, reorderToSlot, resolveVar, runSequence, signalOf, type Signal } from './track';

const result = (status: number, passed = [true], scriptError?: string): RunResult => ({
  finalRequest: { method: 'GET', url: 'http://x', headers: {} }, redirects: [],
  response: { status, statusText: '', headers: {}, body: '', size: 0, truncated: false, timings: { dns: 0, tcp: 0, tls: 0, ttfb: 0, transfer: 0, total: 1 } },
  preScripts: [], testScripts: [{ tests: passed.map((p, i) => ({ name: `t${i}`, passed: p })), logs: [], error: scriptError }],
  scopes: { runtime: {}, environment: [], collection: [], globals: [] },
});

test('station signal', () => {
  expect(signalOf(undefined, false)).toBe('idle');
  expect(signalOf(result(200), true)).toBe('caution');
  expect(signalOf(result(204), false)).toBe('go');
  expect(signalOf(result(301), false)).toBe('stop');
  expect(signalOf(result(200, [true, false]), false)).toBe('stop');
  expect(signalOf(result(200, [], 'boom'), false)).toBe('stop');
  expect(signalOf({ ...result(200), response: undefined, error: { code: 'ECONNREFUSED', message: '' } }, false)).toBe('stop');
  expect(signalOf(undefined, false, '404: not found')).toBe('stop');
});

test('reorder', () => {
  expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  expect(moveItem(['a', 'b', 'c'], 1, 9)).toEqual(['a', 'c', 'b']);
});

test('library groups and variable lookup', () => {
  const req = (id: string, method = 'GET'): RequestItem => ({ kind: 'request', id, name: id, method, url: `{{host}}/${id}`, pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, scripts: { pre: '', test: '' } });
  const c: Collection = {
    id: 'c', name: 'C', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [{ key: 'host', value: 'col', enabled: true }],
    items: [req('top'), { kind: 'folder', id: 'f', name: 'F', auth: { type: 'inherit' }, scripts: { pre: '', test: '' }, items: [req('inner', 'POST')] }],
  };
  expect(libraryGroups([c], '').map((g) => [g.folders.map((f) => f.name), g.requests.map((r) => r.id)])).toEqual([[[], ['top']], [['F'], ['inner']]]);
  expect(libraryGroups([{ ...c, items: [] }], '').map((g) => g.requests)).toEqual([[]]);
  const rows = (q: string, collapsed: string[] = []) => treeRows([c], q, new Set(collapsed)).map((r) => `${r.depth}:${r.item?.id ?? r.collection.id}`);
  expect(rows('')).toEqual(['0:c', '1:top', '1:f', '2:inner']);
  expect(rows('', ['f'])).toEqual(['0:c', '1:top', '1:f']);
  expect(rows('', ['c'])).toEqual(['0:c']);
  expect(rows('post', ['c', 'f'])).toEqual(['0:c', '1:f', '2:inner']); // a query ignores collapsing
  expect(rows('nothing')).toEqual([]);
  expect(libraryGroups([c], 'post').map((g) => g.requests.map((r) => r.id))).toEqual([['inner']]);
  const env = { id: 'e', name: 'E', ignoreTls: false, followRedirects: true, values: [{ key: 'host', value: 'env', enabled: false }] };
  expect(resolveVar('host', env, c, { values: [] })?.value).toBe('col');
  expect(resolveVar('nope', env, c, { values: [] })).toBeUndefined();
});

test('drop into a slot', () => {
  expect(reorderToSlot(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a']);
  expect(reorderToSlot(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'a', 'c']);
  expect(reorderToSlot(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  expect(reorderToSlot(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
});

test('loadTrack drops invalid stations', () => {
  const stored = { name: 'T', stations: [{ id: 's', collectionId: 'c', requestId: 'r' }, null, { id: 's2', collectionId: 'c' }, 'x'] };
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored) });
  try { expect(loadTrack()).toEqual({ name: 'T', stations: [{ id: 's', collectionId: 'c', requestId: 'r' }] }); } finally { vi.unstubAllGlobals(); }
});

test('runSequence: stop on failure, missing request, removed mid-run', async () => {
  const run = async (signals: Record<string, Signal>, stop: () => boolean, exists: (s: string) => boolean = () => true, onRun?: (s: string) => void) => {
    const ran: string[] = [];
    await runSequence(['a', 'b', 'c'], async (s) => { ran.push(s); onRun?.(s); return signals[s] ?? 'go'; }, stop, exists);
    return ran;
  };
  expect(await run({ a: 'stop' }, () => true)).toEqual(['a']);
  expect(await run({ a: 'stop' }, () => false)).toEqual(['a', 'b', 'c']);
  // a missing request is a 'stop' from runOne, like any failure
  expect(await run({ b: 'stop' }, () => true)).toEqual(['a', 'b']);
  // the switch is read after each station, not at start
  let stopNow = false;
  expect(await run({ b: 'stop' }, () => stopNow, undefined, () => { stopNow = true; })).toEqual(['a', 'b']);
  const removed = new Set<string>();
  expect(await run({}, () => true, (s) => !removed.has(s), (s) => { if (s === 'a') removed.add('b'); })).toEqual(['a', 'c']);
});

test('run lock: one claim at a time, released after an error', () => {
  const busy: boolean[] = [];
  const lock = createRunLock((b) => busy.push(b));
  expect(lock.claim()).toBe(true);
  expect(lock.claim()).toBe(false);
  try { throw new Error('run failed'); } catch { /* the run failed */ } finally { lock.release(); }
  expect(lock.claim()).toBe(true);
  expect(busy).toEqual([true, false, true]);
});
