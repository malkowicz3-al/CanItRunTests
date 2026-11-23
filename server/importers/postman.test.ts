import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Collection, Folder, Item, RequestItem } from '../../shared/model';
import { importPostman, keepItemIds } from './postman';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8'));

function importCollection() {
  const r = importPostman(fixture('postman-collection.json'));
  if (r.kind !== 'collection') throw new Error('expected collection');
  return { collection: r.collection, warnings: r.warnings };
}

function find(items: Item[], name: string): Item | undefined {
  for (const i of items) {
    if (i.name === name) return i;
    const inner = i.kind === 'folder' ? find(i.items, name) : undefined;
    if (inner) return inner;
  }
  return undefined;
}
const req = (c: Collection, name: string) => find(c.items, name) as RequestItem;
const folder = (c: Collection, name: string) => find(c.items, name) as Folder;

test('collection tree', () => {
  const { collection: c } = importCollection();
  expect(c.name).toBe('Sample API');
  expect(c.sourceId).toBe('00000000-0000-4000-8000-000000000001');
  expect(c.items.map((i) => [i.kind, i.name])).toEqual([
    ['folder', 'Users'], ['request', 'OAuth call'], ['request', 'Api key in query'], ['request', 'GraphQL'],
  ]);
  expect(folder(c, 'Users').items.map((i) => i.name)).toEqual(['Get user', 'Admin']);
  expect(folder(c, 'Admin').items.map((i) => i.name)).toEqual(['Create user']);
  expect(c.variables).toEqual([
    { key: 'baseUrl', value: 'https://api.example.test', type: 'default', enabled: true },
    { key: 'old', value: 'x', type: 'default', enabled: false },
  ]);
  const get = req(c, 'Get user');
  expect(get.method).toBe('GET');
  expect(get.headers).toEqual([
    { key: 'Accept', value: 'application/json', enabled: true },
    { key: 'X-Debug', value: '1', enabled: false },
  ]);
  expect(req(c, 'OAuth call').method).toBe('GET');
  const create = req(c, 'Create user');
  expect(create.body).toEqual({ mode: 'raw', raw: '{"name":"Alice"}', language: 'json' });
  expect(create.url).toBe('{{baseUrl}}/users');
  expect(req(c, 'Api key in query').body).toEqual({ mode: 'urlencoded', params: [{ key: 'q', value: '1', enabled: true }] });
  expect(new Set([c.id, get.id, create.id, folder(c, 'Users').id]).size).toBe(4);
});

test('scripts at 3 levels', () => {
  const { collection: c } = importCollection();
  expect(c.scripts).toEqual({ pre: "// collection pre\npm.variables.set('a', '1');", test: '// collection test' });
  expect(folder(c, 'Users').scripts).toEqual({ pre: '// folder pre', test: '' });
  expect(req(c, 'Get user').scripts).toEqual({
    pre: '// request pre',
    test: "pm.test('ok', () => pm.response.to.have.status(200));",
  });
});

test('auth mapping incl oauth2→bearer', () => {
  const { collection: c } = importCollection();
  expect(c.auth).toEqual({ type: 'bearer', token: '{{token}}' });
  expect(req(c, 'OAuth call').auth).toEqual({ type: 'bearer', token: 'dummy-access-token' });
  expect(req(c, 'Create user').auth).toEqual({ type: 'basic', username: 'admin', password: 'dummy-password' });
  expect(req(c, 'Api key in query').auth).toEqual({ type: 'apikey', key: 'api_key', value: 'dummy-key', in: 'query' });
});

test('noauth vs inherit', () => {
  const { collection: c } = importCollection();
  expect(folder(c, 'Admin').auth).toEqual({ type: 'none' });
  expect(folder(c, 'Users').auth).toEqual({ type: 'inherit' });
  expect(req(c, 'Get user').auth).toEqual({ type: 'inherit' });
});

test('url object + path variables', () => {
  const get = req(importCollection().collection, 'Get user');
  expect(get.url).toBe('{{baseUrl}}/users/:id?verbose=true');
  expect(get.pathVariables).toEqual([{ key: 'id', value: '42', enabled: true }]);
});

test('environment secret type', () => {
  const r = importPostman(fixture('postman-environment.json'));
  if (r.kind !== 'environment') throw new Error('expected environment');
  expect(r.environment).toMatchObject({
    sourceId: '00000000-0000-4000-8000-000000000002', name: 'Local', ignoreTls: false, followRedirects: true,
  });
  expect(r.environment.values).toEqual([
    { key: 'baseUrl', value: 'https://api.example.test', type: 'default', enabled: true },
    { key: 'token', value: 'dummy-secret-token', type: 'secret', enabled: true },
    { key: 'unused', value: '', type: 'default', enabled: false },
  ]);
});

test('globals', () => {
  expect(importPostman(fixture('postman-globals.json'))).toEqual({
    kind: 'globals',
    globals: { values: [{ key: 'tenant', value: 'demo', type: 'default', enabled: true }] },
    warnings: [],
  });
});

test('rejects v2.0', () => {
  const v20 = { info: { name: 'Old', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [] };
  expect(() => importPostman(v20)).toThrow(/v2\.0 is not supported/);
  for (const bad of [null, [], 'x', {}, { info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: {} }]) {
    expect(() => importPostman(bad)).toThrow(expect.objectContaining({ statusCode: 400 }));
  }
});

test('unknown body → none + warning', () => {
  const { collection: c, warnings } = importCollection();
  expect(req(c, 'GraphQL').body).toEqual({ mode: 'none' });
  expect(warnings).toEqual([expect.stringMatching(/GraphQL.*unsupported body mode 'graphql'/)]);
});

test('keepItemIds matches same-named requests by method', () => {
  const req = (id: string, method: string): RequestItem => ({ kind: 'request', id, name: 'Same', method, url: '', pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, scripts: { pre: '', test: '' } });
  const kept = keepItemIds([req('old-get', 'GET'), req('old-post', 'POST')], [req('n1', 'POST'), req('n2', 'GET'), req('n3', 'GET')]);
  expect(kept.map((i) => i.id)).toEqual(['old-post', 'old-get', 'n3']);
});

test('url object without raw is rebuilt', () => {
  const r = importPostman({
    info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', name: 'c' },
    item: [{ name: 'u', request: { method: 'GET', url: { protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['v1', ':id'], query: [{ key: 'a', value: '1' }, { key: 'off', value: 'x', disabled: true }, { key: 'flag' }] } } }],
  });
  if (r.kind !== 'collection') throw new Error('expected collection');
  expect((r.collection.items[0] as RequestItem).url).toBe('https://api.example.com:8443/v1/:id?a=1&flag');
  const h = importPostman({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', name: 'c' }, item: [{ name: 'u', request: { url: { host: '{{base}}', path: '/x' } } }] });
  if (h.kind === 'collection') expect((h.collection.items[0] as RequestItem).url).toBe('{{base}}/x');
  const o = importPostman({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', name: 'c' }, item: [{ name: 'u', request: { url: { host: 'h', path: ['v1', { type: 'string', value: ':id' }], hash: 'top' } } }] });
  if (o.kind === 'collection') expect((o.collection.items[0] as RequestItem).url).toBe('h/v1/:id#top');
});
