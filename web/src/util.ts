import type { Item, KeyValue, RequestItem } from '../../shared/model';

// randomUUID needs a secure context; HOST=0.0.0.0 opened over plain http from another machine is not one
export const uid = () =>
  crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Query params as written in the raw URL (no decoding, so {{vars}} stay intact). */
export function parseQuery(url: string): KeyValue[] {
  const i = url.indexOf('?');
  if (i < 0) return [];
  return url.slice(i + 1).split('&').filter(Boolean).map((p) => {
    const j = p.indexOf('=');
    return j < 0 ? { key: p, value: '', enabled: true } : { key: p.slice(0, j), value: p.slice(j + 1), enabled: true };
  });
}

export function withQuery(url: string, params: KeyValue[]): string {
  const base = url.split('?')[0];
  const q = params.filter((p) => p.key || p.value).map((p) => (p.value ? `${p.key}=${p.value}` : p.key)).join('&');
  return q ? `${base}?${q}` : base;
}

/** Path variables follow the ':name' segments of the URL, keeping known values. */
export function syncPathVars(url: string, vars: KeyValue[]): KeyValue[] {
  const keys = [...new Set([...url.split('?')[0].matchAll(/\/:([A-Za-z0-9_.-]+)/g)].map((m) => m[1]))];
  return keys.map((key) => vars.find((v) => v.key === key) ?? { key, value: '', enabled: true });
}

/** Replaces (or removes, when fn returns null) the item with the given id anywhere in the tree. */
export function updateTree(items: Item[], id: string, fn: (item: Item) => Item | null): Item[] {
  return items.flatMap((it) => {
    if (it.id === id) return fn(it) ?? [];
    return it.kind === 'folder' ? [{ ...it, items: updateTree(it.items, id, fn) }] : [it];
  });
}

/** Chain of items from the root down to the item with the given id, empty when not found. */
export function findPath(items: Item[], id: string): Item[] {
  for (const it of items) {
    if (it.id === id) return [it];
    if (it.kind === 'folder') {
      const sub = findPath(it.items, id);
      if (sub.length) return [it, ...sub];
    }
  }
  return [];
}

/** Counter next to each request part's title (0 = nothing set): Params, Headers, Body, Auth, Scripts, Settings. */
export function requestCounts(r: RequestItem): Record<'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings', number | string> {
  return {
    params: parseQuery(r.url).length + r.pathVariables.length,
    headers: r.headers.filter((h) => h.enabled).length,
    body: r.body.mode === 'none' ? 0 : r.body.mode === 'raw' ? r.body.language : r.body.params.length,
    auth: r.auth.type === 'inherit' ? 0 : r.auth.type,
    scripts: [r.scripts.pre, r.scripts.test].filter((s) => s.trim()).length,
    settings: r.followRedirects === undefined ? 0 : 1,
  };
}

export const itemIds = (it: Item): string[] => [it.id, ...(it.kind === 'folder' ? it.items.flatMap(itemIds) : [])];

// shortcut: line-based, breaks text containing '><' (e.g. CDATA); use a real parser if that shows up
export function prettyXml(xml: string): string {
  let depth = 0;
  return xml.trim().replace(/>\s*</g, '>\n<').split('\n').map((raw) => {
    const line = raw.trim();
    if (line.startsWith('</')) depth = Math.max(depth - 1, 0);
    const out = '  '.repeat(depth) + line;
    if (/^<[^/?!]/.test(line) && !line.endsWith('/>') && !line.includes('</')) depth++;
    return out;
  }).join('\n');
}

export function prettyBody(body: string, contentType = ''): { text: string; language: string } {
  const ct = contentType.toLowerCase();
  if (ct.includes('json') || /^\s*[[{]/.test(body)) {
    try { return { text: JSON.stringify(JSON.parse(body), null, 2), language: 'json' }; } catch { /* not JSON after all */ }
  }
  if (ct.includes('html')) return { text: body, language: 'html' };
  if (ct.includes('xml') || /^\s*<\?xml/.test(body)) return { text: prettyXml(body), language: 'xml' };
  return { text: body, language: 'plaintext' };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
