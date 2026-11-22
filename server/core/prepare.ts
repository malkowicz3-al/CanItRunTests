import { randomUUID } from 'node:crypto';
import type { PreparedRequest, Scopes } from '../../shared/api';
import type { Auth, Collection, Folder, Id, KeyValue, RequestItem } from '../../shared/model';
import { resolve } from './variables';

export interface Prepared {
  item: RequestItem;
  auth: Auth; // effective, never 'inherit'
  pre: string[]; // collection -> folders -> request, empty scripts skipped
  test: string[];
}

function findPath(items: Collection['items'], id: Id, parents: Folder[] = []): { item: RequestItem; parents: Folder[] } | undefined {
  for (const it of items) {
    if (it.kind === 'request' && it.id === id) return { item: it, parents };
    if (it.kind === 'folder') {
      const found = findPath(it.items, id, [...parents, it]);
      if (found) return found;
    }
  }
  return undefined;
}

/** `override` (unsaved editor state) replaces the stored request; a request not yet in the collection inherits from the collection only. */
export function prepare(collection: Collection, requestId: Id, override?: RequestItem): Prepared {
  const found = findPath(collection.items, requestId);
  const item = override ?? found?.item;
  if (!item) throw Object.assign(new Error(`Request ${requestId} not found in collection ${collection.id}`), { statusCode: 404 });
  const levels = [collection, ...(found?.parents ?? []), item];
  const auth = levels.map((l) => l.auth).reverse().find((a) => a.type !== 'inherit') ?? { type: 'none' };
  return {
    item,
    auth,
    pre: levels.map((l) => l.scripts.pre).filter((s) => s.trim()),
    test: levels.map((l) => l.scripts.test).filter((s) => s.trim()),
  };
}

const enabled = (kv: KeyValue[]) => kv.filter((x) => x.enabled);

/**
 * Request as pre-scripts see it (pm.request), like Postman: unresolved {{templates}}, no auth, no auto headers.
 * Only raw bodies are exposed; urlencoded/formdata are encoded from their params in finalize().
 */
export function template(item: RequestItem): PreparedRequest {
  return {
    method: item.method,
    url: item.url,
    headers: Object.fromEntries(enabled(item.headers).map((h) => [h.key, h.value])),
    body: item.body.mode === 'raw' ? item.body.raw : undefined,
  };
}

const CONTENT_TYPES = { json: 'application/json', xml: 'application/xml', text: 'text/plain' };

/** Final request after all pre-scripts: resolves variables, path variables, body and auth. */
export function finalize(p: Prepared, req: PreparedRequest, s: Scopes): PreparedRequest {
  const r = (t: string) => resolve(t, s);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[r(k)] = r(v);
  const has = (k: string) => Object.keys(headers).some((h) => h.toLowerCase() === k.toLowerCase());
  // explicit headers (from the editor or a pre-script) win over auth and auto headers
  const setDefault = (k: string, v: string) => { if (!has(k)) headers[k] = v; };

  let url = r(req.url);
  for (const pv of enabled(p.item.pathVariables)) {
    url = url.replace(new RegExp(`/:${pv.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/?#]|$)`, 'g'), () => `/${r(pv.value)}`);
  }

  let body: string | undefined;
  const b = p.item.body;
  if (req.body !== template(p.item).body) body = req.body === undefined ? undefined : r(req.body); // set by a pre-script
  else if (b.mode === 'raw') { body = r(b.raw); setDefault('Content-Type', CONTENT_TYPES[b.language]); }
  else if (b.mode === 'urlencoded') {
    body = new URLSearchParams(enabled(b.params).map((x) => [r(x.key), r(x.value)])).toString();
    setDefault('Content-Type', 'application/x-www-form-urlencoded');
  } else if (b.mode === 'formdata') {
    const boundary = `----CanItRunTests${randomUUID().replaceAll('-', '')}`;
    body = enabled(b.params).map((x) => `--${boundary}\r\nContent-Disposition: form-data; name="${r(x.key)}"\r\n\r\n${r(x.value)}\r\n`).join('') + `--${boundary}--\r\n`;
    setDefault('Content-Type', `multipart/form-data; boundary=${boundary}`);
  }

  const a = p.auth;
  if (a.type === 'bearer') setDefault('Authorization', `Bearer ${r(a.token)}`);
  else if (a.type === 'basic') setDefault('Authorization', `Basic ${Buffer.from(`${r(a.username)}:${r(a.password)}`).toString('base64')}`);
  else if (a.type === 'apikey' && a.in === 'header') setDefault(r(a.key), r(a.value));
  else if (a.type === 'apikey') url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(r(a.key))}=${encodeURIComponent(r(a.value))}`;

  return { method: r(req.method).toUpperCase(), url, headers, body };
}
