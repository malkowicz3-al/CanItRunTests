import { expect, test } from 'vitest';
import type { Scopes } from '../../shared/api';
import type { Auth, Collection, Folder, RequestItem } from '../../shared/model';
import { finalize, prepare, template } from './prepare';
import { runScript } from './sandbox';

const scripts = (pre: string, t = '') => ({ pre, test: t });
const req = (id: string, p: Partial<RequestItem> = {}): RequestItem => ({
  kind: 'request', id, name: id, method: 'GET', url: '{{base}}/users/:id', pathVariables: [{ key: 'id', value: '{{uid}}', enabled: true }],
  headers: [{ key: 'Accept', value: '{{accept}}', enabled: true }, { key: 'X-Off', value: '1', enabled: false }],
  body: { mode: 'none' }, auth: { type: 'inherit' }, scripts: scripts(''), ...p,
});
const folder = (id: string, items: Folder['items'], auth: Auth = { type: 'inherit' }, pre = ''): Folder => ({ kind: 'folder', id, name: id, items, auth, scripts: scripts(pre, `${id} test`) });
const collection = (items: Collection['items'], auth: Auth = { type: 'bearer', token: '{{token}}' }): Collection =>
  ({ id: 'c', name: 'c', items, auth, scripts: scripts('col pre', 'col test'), variables: [] });
const scopes = (): Scopes => ({
  runtime: {}, collection: [], globals: [],
  environment: [{ key: 'base', value: 'http://h', enabled: true }, { key: 'uid', value: '42', enabled: true }, { key: 'accept', value: 'application/json', enabled: true }, { key: 'token', value: 'T', enabled: true }],
});
const build = (c: Collection, id: string) => { const p = prepare(c, id); return finalize(p, template(p.item), scopes()); };

test('script order', () => {
  const c = collection([folder('f1', [folder('f2', [req('r', { scripts: scripts('req pre', 'req test') })], undefined, 'f2 pre')], undefined, '')]);
  const p = prepare(c, 'r');
  expect(p.pre).toEqual(['col pre', 'f2 pre', 'req pre']); // empty folder script skipped
  expect(p.test).toEqual(['col test', 'f1 test', 'f2 test', 'req test']);
});

test('auth inheritance nearest', () => {
  const basic: Auth = { type: 'basic', username: 'u', password: 'p' };
  const c = collection([folder('f1', [folder('f2', [req('r'), req('own', { auth: { type: 'none' } })])], basic), req('top')]);
  expect(prepare(c, 'r').auth).toEqual(basic);
  expect(prepare(c, 'own').auth).toEqual({ type: 'none' });
  expect(prepare(c, 'top').auth).toEqual({ type: 'bearer', token: '{{token}}' });
  expect(prepare(collection([req('x')], { type: 'inherit' }), 'x').auth).toEqual({ type: 'none' });
  expect(() => prepare(c, 'missing')).toThrow(/not found/);
});

test('resolves url, path variables, headers and bearer', () => {
  expect(build(collection([req('r')]), 'r')).toEqual({ method: 'GET', url: 'http://h/users/42', headers: { Accept: 'application/json', Authorization: 'Bearer T' }, body: undefined });
});

test('apikey query', () => {
  const c = collection([req('r', { url: '{{base}}/s?x=1', auth: { type: 'apikey', key: 'api key', value: '{{token}}', in: 'query' } })]);
  expect(build(c, 'r').url).toBe('http://h/s?x=1&api%20key=T');
});

test('basic header', () => {
  const c = collection([req('r', { auth: { type: 'basic', username: 'admin', password: '{{token}}' } })]);
  expect(build(c, 'r').headers.Authorization).toBe(`Basic ${Buffer.from('admin:T').toString('base64')}`);
});

test('bodies get content type', () => {
  const raw = build(collection([req('r', { method: 'POST', body: { mode: 'raw', raw: '{"u":"{{uid}}"}', language: 'json' } })]), 'r');
  expect(raw).toMatchObject({ body: '{"u":"42"}', headers: { 'Content-Type': 'application/json' } });
  const form = build(collection([req('r', { body: { mode: 'urlencoded', params: [{ key: 'a b', value: '{{uid}}', enabled: true }] } })]), 'r');
  expect(form).toMatchObject({ body: 'a+b=42', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
});

test('pre-script mutates request before send', async () => {
  const c = collection([req('r', { method: 'POST', body: { mode: 'raw', raw: 'old', language: 'text' } })], { type: 'none' });
  const p = prepare(c, 'r');
  const s = scopes();
  const request = template(p.item);
  const r = await runScript(`
    pm.environment.set('seenUrl', pm.request.url.toString());
    pm.request.headers.upsert({ key: 'X-Sig', value: '{{uid}}-sig' });
    pm.request.body.raw = 'new {{uid}}';
    pm.environment.set('uid', '7');
  `, { scopes: s, request });
  expect(r.error).toBeUndefined();
  expect(s.environment.find((v) => v.key === 'seenUrl')!.value).toBe('{{base}}/users/:id'); // unresolved, like Postman
  expect(finalize(p, request, s)).toMatchObject({ url: 'http://h/users/7', body: 'new 7', headers: { 'X-Sig': '7-sig' } });
});
