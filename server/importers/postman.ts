import { randomUUID } from 'node:crypto';
import type { Auth, Body, Collection, Environment, Globals, Item, KeyValue, Scripts, Variable } from '../../shared/model';

export type PostmanImport = (
  | { kind: 'collection'; collection: Collection }
  | { kind: 'environment'; environment: Environment }
  | { kind: 'globals'; globals: Globals }
) & { warnings: string[] };

type Obj = Record<string, unknown>;

const fail = (msg: string): never => { throw Object.assign(new Error(msg), { statusCode: 400 }); };
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (x === undefined || x === null ? '' : String(x));

function obj(x: unknown, where: string): Obj {
  return isObj(x) ? x : fail(`${where}: expected an object`);
}

function arr(x: unknown, where: string): unknown[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : fail(`${where}: expected an array`);
}

function keyValues(x: unknown, where: string): KeyValue[] {
  return arr(x, where).map((e, i) => {
    const o = obj(e, `${where}[${i}]`);
    return { key: str(o.key), value: str(o.value), enabled: o.disabled !== true };
  });
}

function variables(x: unknown, where: string): Variable[] {
  return arr(x, where).map((e, i) => {
    const o = obj(e, `${where}[${i}]`);
    // collection variables use `disabled`, environment/globals use `enabled`
    const enabled = o.enabled === undefined ? o.disabled !== true : o.enabled !== false;
    return { key: str(o.key), value: str(o.value), type: o.type === 'secret' ? 'secret' : 'default', enabled };
  });
}

function scripts(event: unknown, where: string): Scripts {
  const out: Scripts = { pre: '', test: '' };
  arr(event, where).forEach((e, i) => {
    const o = obj(e, `${where}[${i}]`);
    const exec = isObj(o.script) ? o.script.exec : undefined;
    const code = Array.isArray(exec) ? exec.map(str).join('\n') : str(exec);
    if (o.listen === 'prerequest') out.pre = code;
    else if (o.listen === 'test') out.test = code;
  });
  return out;
}

function auth(x: unknown, where: string, warnings: string[]): Auth {
  if (x === undefined || x === null) return { type: 'inherit' };
  const o = obj(x, where);
  const attr = (name: string) => {
    const found = arr(o[str(o.type)], `${where}.${str(o.type)}`).find((a) => isObj(a) && a.key === name);
    return isObj(found) ? str(found.value) : '';
  };
  switch (o.type) {
    case 'noauth': return { type: 'none' };
    case 'bearer': return { type: 'bearer', token: attr('token') };
    case 'oauth2': return { type: 'bearer', token: attr('accessToken') };
    case 'basic': return { type: 'basic', username: attr('username'), password: attr('password') };
    case 'apikey': return { type: 'apikey', key: attr('key'), value: attr('value'), in: attr('in') === 'query' ? 'query' : 'header' };
    default:
      warnings.push(`${where}: unsupported auth type '${str(o.type)}', set to none`);
      return { type: 'none' };
  }
}

function body(x: unknown, where: string, warnings: string[]): Body {
  if (x === undefined || x === null) return { mode: 'none' };
  const o = obj(x, where);
  switch (o.mode) {
    case undefined: case 'none': return { mode: 'none' };
    case 'raw': {
      const options = isObj(o.options) && isObj(o.options.raw) ? o.options.raw : {};
      const language = options.language === 'json' || options.language === 'xml' ? options.language : 'text';
      return { mode: 'raw', raw: str(o.raw), language };
    }
    case 'urlencoded': return { mode: 'urlencoded', params: keyValues(o.urlencoded, `${where}.urlencoded`) };
    case 'formdata': {
      const fields = arr(o.formdata, `${where}.formdata`);
      const text = fields.filter((f) => !(isObj(f) && f.type === 'file'));
      if (text.length < fields.length) warnings.push(`${where}: file fields in form-data were dropped`);
      return { mode: 'formdata', params: keyValues(text, `${where}.formdata`) };
    }
    default:
      warnings.push(`${where}: unsupported body mode '${str(o.mode)}', set to none`);
      return { mode: 'none' };
  }
}

function rebuildUrl(u: Obj): string {
  const join = (x: unknown, sep: string) => (Array.isArray(x) ? x.map((p) => str(isObj(p) ? p.value : p)).join(sep) : str(x));
  const path = join(u.path, '/');
  const query = arr(u.query, 'url.query').filter((q) => isObj(q) && q.disabled !== true)
    .map((q) => { const o = q as Obj; return o.value === undefined || o.value === null ? str(o.key) : `${str(o.key)}=${str(o.value)}`; }).join('&');
  return `${u.protocol ? `${str(u.protocol)}://` : ''}${join(u.host, '.')}${u.port ? `:${str(u.port)}` : ''}${path && !path.startsWith('/') ? '/' : ''}${path}${query ? `?${query}` : ''}${u.hash ? `#${str(u.hash)}` : ''}`;
}

function item(x: unknown, where: string, warnings: string[]): Item {
  const o = obj(x, where);
  const name = str(o.name);
  const at = `${where} '${name}'`;
  if (o.item !== undefined) {
    return {
      kind: 'folder', id: randomUUID(), name,
      items: arr(o.item, `${at}.item`).map((c, i) => item(c, `${at}.item[${i}]`, warnings)),
      auth: auth(o.auth, `${at}.auth`, warnings), scripts: scripts(o.event, `${at}.event`),
    };
  }
  const req = typeof o.request === 'string' ? { url: o.request } : obj(o.request, `${at}.request`);
  let url = '';
  let pathVariables: KeyValue[] = [];
  if (isObj(req.url)) {
    url = req.url.raw !== undefined ? str(req.url.raw) : rebuildUrl(req.url);
    pathVariables = keyValues(req.url.variable, `${at}.request.url.variable`);
  } else {
    url = str(req.url);
  }
  return {
    kind: 'request', id: randomUUID(), name,
    method: str(req.method || 'GET').toUpperCase(),
    url, pathVariables,
    headers: typeof req.header === 'string' ? [] : keyValues(req.header, `${at}.request.header`),
    body: body(req.body, `${at}.request.body`, warnings),
    auth: auth(req.auth, `${at}.request.auth`, warnings),
    scripts: scripts(o.event, `${at}.event`),
  };
}

export function importPostman(json: unknown): PostmanImport {
  const root = obj(json, 'import');
  const warnings: string[] = [];

  if (isObj(root.info)) {
    const schema = str(root.info.schema);
    if (schema.includes('/v2.0.')) fail('Postman Collection v2.0 is not supported; export the collection as v2.1');
    if (!schema.includes('/v2.1.')) fail(`Unsupported collection schema '${schema}'; expected Postman Collection v2.1`);
    const collection: Collection = {
      id: randomUUID(),
      sourceId: typeof root.info._postman_id === 'string' ? root.info._postman_id : undefined,
      name: str(root.info.name) || 'Imported collection',
      items: arr(root.item, 'item').map((c, i) => item(c, `item[${i}]`, warnings)),
      auth: auth(root.auth, 'auth', warnings),
      scripts: scripts(root.event, 'event'),
      variables: variables(root.variable, 'variable'),
    };
    return { kind: 'collection', collection, warnings };
  }

  const scope = root._postman_variable_scope;
  if (scope === 'environment') {
    const environment: Environment = {
      id: randomUUID(),
      sourceId: typeof root.id === 'string' ? root.id : undefined,
      name: str(root.name) || 'Imported environment',
      values: variables(root.values, 'values'),
      ignoreTls: false,
      followRedirects: true,
    };
    return { kind: 'environment', environment, warnings };
  }
  if (scope === 'globals') return { kind: 'globals', globals: { values: variables(root.values, 'values') }, warnings };

  return fail('Unrecognized file: expected a Postman v2.1 collection, environment or globals export');
}

/**
 * On a re-import the items get the ids they had at the same path (folder names, then the name; the method breaks ties),
 * so track stations and drafts still point at them.
 */
export function keepItemIds(old: Item[], fresh: Item[]): Item[] {
  const byKey = new Map<string, Item[]>();
  const key = (it: Item, at: string) => JSON.stringify([at, it.kind, it.name]);
  const collect = (items: Item[], at: string) => items.forEach((it) => {
    const k = key(it, at);
    byKey.set(k, [...(byKey.get(k) ?? []), it]);
    if (it.kind === 'folder') collect(it.items, k);
  });
  const apply = (items: Item[], at: string): Item[] => items.map((it) => {
    const k = key(it, at);
    const candidates = byKey.get(k) ?? [];
    const i = Math.max(0, candidates.findIndex((c) => c.kind === 'request' && it.kind === 'request' && c.method === it.method));
    const id = candidates.splice(i, 1)[0]?.id ?? it.id;
    return it.kind === 'folder' ? { ...it, id, items: apply(it.items, k) } : { ...it, id };
  });
  collect(old, '');
  return apply(fresh, '');
}
