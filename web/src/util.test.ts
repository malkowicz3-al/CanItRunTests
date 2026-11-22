import { expect, test } from 'vitest';
import type { Item, RequestItem } from '../../shared/model';
import { findPath, parseQuery, prettyBody, requestCounts, syncPathVars, updateTree, withQuery } from './util';

test('query params round-trip through the raw URL', () => {
  const url = 'https://{{host}}/a/:id?x=1&flag&t={{token}}';
  const q = parseQuery(url);
  expect(q.map((p) => [p.key, p.value])).toEqual([['x', '1'], ['flag', ''], ['t', '{{token}}']]);
  expect(withQuery(url, q)).toBe(url);
  expect(withQuery(url, [])).toBe('https://{{host}}/a/:id');
  expect(syncPathVars(url, [{ key: 'id', value: '7', enabled: true }, { key: 'old', value: '', enabled: true }])).toEqual([{ key: 'id', value: '7', enabled: true }]);
});

test('tree update and lookup', () => {
  const req = (id: string): Item => ({ kind: 'request', id, name: id, method: 'GET', url: '', pathVariables: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, scripts: { pre: '', test: '' } });
  const items: Item[] = [{ kind: 'folder', id: 'f', name: 'f', items: [req('a'), req('b')], auth: { type: 'inherit' }, scripts: { pre: '', test: '' } }];
  expect(findPath(items, 'b').map((i) => i.id)).toEqual(['f', 'b']);
  const removed = updateTree(items, 'a', () => null);
  expect(findPath(removed, 'a')).toEqual([]);
  expect(findPath(updateTree(items, 'b', (i) => ({ ...i, name: 'B' })), 'b')[1].name).toBe('B');
});

test('response bodies are pretty-printed', () => {
  expect(prettyBody('{"a":[1]}', 'application/json')).toEqual({ text: '{\n  "a": [\n    1\n  ]\n}', language: 'json' });
  expect(prettyBody('<a><b x="1"/><c>t</c></a>', 'application/xml').text).toBe('<a>\n  <b x="1"/>\n  <c>t</c>\n</a>');
  expect(prettyBody('{broken', 'application/json').language).toBe('plaintext');
});

test('request part counters', () => {
  const r: RequestItem = {
    kind: 'request', id: 'r', name: 'r', method: 'POST', url: 'http://x/:id?a=1&b', pathVariables: [{ key: 'id', value: '', enabled: true }],
    headers: [{ key: 'A', value: '', enabled: true }, { key: 'B', value: '', enabled: false }], body: { mode: 'raw', raw: '{}', language: 'json' },
    auth: { type: 'inherit' }, scripts: { pre: ' ', test: 'pm.test()' }, followRedirects: false,
  };
  expect(requestCounts(r)).toEqual({ params: 3, headers: 1, body: 'json', auth: 0, scripts: 1, settings: 1 });
});
