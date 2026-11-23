import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Scopes } from '../../shared/api';
import type { Collection, RequestItem } from '../../shared/model';
import { startMockServer } from '../../test/mockServer';
import { applyDiff, diffScopes, runRequest } from './run';

let mock: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => { mock = await startMockServer(); });
afterAll(() => mock.close());

const request = (p: Partial<RequestItem> = {}): RequestItem => ({
  kind: 'request', id: 'r', name: 'Echo', method: 'POST', url: '{{base}}/echo', pathVariables: [], headers: [],
  body: { mode: 'raw', raw: '{"sig":"{{sig}}"}', language: 'json' }, auth: { type: 'none' },
  scripts: {
    pre: `pm.variables.set('sig', 'abc'); pm.environment.set('counter', '1');`,
    test: `pm.test('status', () => pm.response.to.have.status(200));
           pm.test('body', () => pm.expect(pm.response.json().body).to.equal('{"sig":"abc"}'));
           pm.collectionVariables.set('last', pm.response.json().method);`,
  },
  ...p,
});
const collection = (r: RequestItem): Collection => ({ id: 'c', name: 'c', items: [r], auth: { type: 'none' }, scripts: { pre: '', test: '' }, variables: [] });
const scopes = (): Scopes => ({ runtime: {}, environment: [{ key: 'base', value: mock.http, enabled: true }], collection: [], globals: [] });

test('full run returns finalRequest+tests', async () => {
  const r = await runRequest({ collection: collection(request()), requestId: 'r', scopes: scopes() });
  expect(r.error).toBeUndefined();
  expect(r.finalRequest).toMatchObject({ method: 'POST', url: `${mock.http}/echo`, body: '{"sig":"abc"}', headers: { 'Content-Type': 'application/json' } });
  expect(r.response!.status).toBe(200);
  expect(r.preScripts).toHaveLength(1);
  expect(r.testScripts[0].tests).toEqual([{ name: 'status', passed: true }, { name: 'body', passed: true }]);
});

test('script var persisted in scopes', async () => {
  const before = scopes();
  const s = structuredClone(before);
  const r = await runRequest({ collection: collection(request()), requestId: 'r', scopes: s });
  expect(r.scopes.environment.find((v) => v.key === 'counter')!.value).toBe('1');
  expect(r.scopes.collection).toEqual([{ key: 'last', value: 'POST', enabled: true }]);
  expect(diffScopes(before, r.scopes)).toEqual({
    environment: { set: [{ key: 'counter', value: '1', enabled: true }], unset: [] },
    collection: { set: [{ key: 'last', value: 'POST', enabled: true }], unset: [] },
  });
});

test('applyDiff keeps keys it did not touch', () => {
  const v = (key: string, value: string) => ({ key, value, enabled: true });
  const before = [v('a', '1'), v('b', '1')];
  const d = diffScopes({ runtime: {}, environment: before, collection: [], globals: [] }, { runtime: {}, environment: [v('a', '2')], collection: [], globals: [] }).environment!;
  expect(d).toEqual({ set: [v('a', '2')], unset: ['b'] });
  expect(applyDiff([v('a', '1'), v('b', '1'), v('c', 'saved meanwhile')], d)).toEqual([v('a', '2'), v('c', 'saved meanwhile')]);
});

test('http error surfaces', async () => {
  const r = await runRequest({ collection: collection(request({ url: 'http://127.0.0.1:1/x' })), requestId: 'r', scopes: scopes() });
  expect(r.error!.code).toBe('ECONNREFUSED');
  expect(r.response).toBeUndefined();
  expect(r.testScripts).toEqual([]);
});

test('failing pre-script cancels the request', async () => {
  const r = await runRequest({ collection: collection(request({ scripts: { pre: 'throw new Error("x")', test: '' } })), requestId: 'r', scopes: scopes() });
  expect(r.error!.code).toBe('ESCRIPT');
  expect(r.response).toBeUndefined();
});

test('followRedirects: request overrides environment', async () => {
  const env = { id: 'e', name: 'e', values: [], ignoreTls: false, followRedirects: true };
  const r = await runRequest({ collection: collection(request({ method: 'GET', url: '{{base}}/redirect?status=302', body: { mode: 'none' }, followRedirects: false })), requestId: 'r', scopes: scopes(), env });
  expect(r.response!.status).toBe(302);
  const r2 = await runRequest({ collection: collection(request({ method: 'GET', url: '{{base}}/redirect?status=302', body: { mode: 'none' } })), requestId: 'r', scopes: scopes(), env: { ...env, followRedirects: false } });
  expect(r2.response!.status).toBe(302);
});

test('abort mid-request returns ECANCELED faster than mock delay', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const start = Date.now();
  const r = await runRequest({ collection: collection(request({ method: 'GET', url: '{{base}}/slow?ms=3000', body: { mode: 'none' }, scripts: { pre: '', test: '' } })), requestId: 'r', scopes: scopes(), signal: ac.signal });
  expect(Date.now() - start).toBeLessThan(1000);
  expect(r.error!.code).toBe('ECANCELED');
  expect(r.response).toBeUndefined();
});

test('pm.execution.skipRequest skips sending', async () => {
  const r = await runRequest({ collection: collection(request({ scripts: { pre: 'pm.execution.skipRequest()', test: '' } })), requestId: 'r', scopes: scopes() });
  expect(r.error).toEqual({ code: 'ESKIPPED', message: 'Request skipped by pre-request script' });
  expect(r.response).toBeUndefined();
  expect(r.preScripts[0].skipped).toBe(true);
});
