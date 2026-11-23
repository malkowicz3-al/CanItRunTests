import { expect, test } from 'vitest';
import type { Collection, RequestItem } from '../../shared/model';
import { createRunLock, libraryGroups, resolveVar } from './track';

test('library groups and variable lookup', () => {
  const req = (id: string, method = 'GET'): RequestItem => ({ kind: 'request', id, name: id, method, url: `{{host}}/${id}`, pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, scripts: { pre: '', test: '' } });
  const c: Collection = {
    id: 'c', name: 'C', auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [{ key: 'host', value: 'col', enabled: true }],
    items: [req('top'), { kind: 'folder', id: 'f', name: 'F', auth: { type: 'inherit' }, scripts: { pre: '', test: '' }, items: [req('inner', 'POST')] }],
  };
  expect(libraryGroups([c], '').map((g) => [g.folders.map((f) => f.name), g.requests.map((r) => r.id)])).toEqual([[[], ['top']], [['F'], ['inner']]]);
  expect(libraryGroups([{ ...c, items: [] }], '').map((g) => g.requests)).toEqual([[]]);
  expect(libraryGroups([c], 'post').map((g) => g.requests.map((r) => r.id))).toEqual([['inner']]);
  const env = { id: 'e', name: 'E', ignoreTls: false, followRedirects: true, values: [{ key: 'host', value: 'env', enabled: false }] };
  expect(resolveVar('host', env, c, { values: [] })?.value).toBe('col');
  expect(resolveVar('nope', env, c, { values: [] })).toBeUndefined();
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
