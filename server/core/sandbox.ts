import crypto from 'node:crypto';
import { format } from 'node:util';
import vm from 'node:vm';
import chai from 'chai';
import CryptoJS from 'crypto-js';
// Static import so esbuild rewrites ESM-only jose into the CJS bundle.
import * as jose from 'jose';
import jsrsasign from 'jsrsasign';
import type { HttpResponse, PreparedRequest, Scopes, ScriptResult } from '../../shared/api';
import type { Variable } from '../../shared/model';
import { HTTP_TIMEOUT_MS, SCRIPT_TIMEOUT_MS } from '../config';
import { execute, type HttpResult } from './http';
import { getVar, resolve } from './variables';

export interface ScriptCtx {
  scopes: Scopes; // mutated in place
  request: PreparedRequest; // pm.request, mutable in pre-scripts
  response?: HttpResponse;
  requestName?: string;
  send?: (req: PreparedRequest) => Promise<HttpResult>; // pm.sendRequest
}

const ARGS = '__citrScriptArgs';
const libs: Record<string, unknown> = { crypto, jose, jsrsasign, 'crypto-js': CryptoJS };
const cache = new Map<string, vm.Script>();

function compile(code: string): vm.Script {
  let script = cache.get(code);
  if (!script) {
    if (cache.size >= 500) cache.clear(); // shortcut: crude bound for edited scripts in a long-lived worker, LRU if it matters
    // user code starts on line 1 so stack traces keep its line numbers
    script = new vm.Script(
      `(async function (pm, console, require, CryptoJS, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate) {${code}\n}).apply(undefined, globalThis.${ARGS})`,
      { filename: 'script.js' },
    );
    cache.set(code, script);
  }
  return script;
}

// Implicit globals (`token = ...`) land on the worker's globalThis; removed once no script is running.
let activeScripts = 0;
let baseGlobals = new Set<string>();

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function scopeApi(list: Variable[]) {
  return {
    get: (key: string) => list.find((v) => v.enabled && v.key === key)?.value,
    has: (key: string) => list.some((v) => v.enabled && v.key === key),
    set: (key: string, value: unknown) => {
      const v = list.find((x) => x.key === key);
      if (v) Object.assign(v, { value: String(value), enabled: true });
      else list.push({ key, value: String(value), enabled: true });
    },
    unset: (key: string) => {
      const i = list.findIndex((x) => x.key === key);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

function wrapRequest(req: PreparedRequest) {
  const find = (k: string) => Object.keys(req.headers).find((h) => h.toLowerCase() === k.toLowerCase());
  const remove = (k: string) => { const h = find(k); if (h !== undefined) delete req.headers[h]; };
  const upsert = (h: { key: string; value: unknown }) => { remove(h.key); req.headers[h.key] = String(h.value); };
  return {
    get method() { return req.method; },
    set method(m: string) { req.method = m; },
    get url() { return { toString: () => req.url }; },
    set url(u: unknown) { req.url = String(u); },
    headers: { get: (k: string) => { const h = find(k); return h === undefined ? undefined : req.headers[h]; }, add: upsert, upsert, remove, toObject: () => ({ ...req.headers }) },
    body: { get raw() { return req.body ?? ''; }, set raw(v: unknown) { req.body = String(v); }, toString: () => req.body ?? '' },
  };
}

function wrapResponse(r: HttpResponse) {
  const header = (k: string) => { const v = r.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v; };
  return {
    code: r.status,
    status: r.statusText,
    responseTime: r.timings.total,
    headers: { get: header, has: (k: string) => header(k) !== undefined, toObject: () => ({ ...r.headers }) },
    text: () => r.body,
    json: () => JSON.parse(r.body),
    to: { have: { status: (code: number) => { chai.expect(r.status, 'response status').to.equal(code); } } },
  };
}

type PostmanRequest = { url: unknown; method?: string; header?: unknown; body?: { mode?: string; raw?: unknown; urlencoded?: { key: string; value: unknown }[] } };

function toPrepared(r: string | PostmanRequest): PreparedRequest {
  if (typeof r === 'string') return { method: 'GET', url: r, headers: {} };
  const headers: Record<string, string> = {};
  const list = Array.isArray(r.header) ? r.header.map((h) => [h.key, h.value]) : Object.entries(r.header ?? {});
  for (const [k, v] of list) headers[k] = String(v);
  let body: string | undefined;
  if (r.body?.mode === 'urlencoded') {
    body = new URLSearchParams((r.body.urlencoded ?? []).map((p) => [p.key, String(p.value)])).toString();
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (r.body?.raw !== undefined) body = String(r.body.raw);
  return { method: (r.method ?? 'GET').toUpperCase(), url: String(r.url), headers, body };
}

export async function runScript(code: string, ctx: ScriptCtx): Promise<ScriptResult> {
  const send = ctx.send ?? ((r) => execute(r, { ignoreTls: false, timeoutMs: HTTP_TIMEOUT_MS }));
  const result: ScriptResult = { tests: [], logs: [] };
  const fail = (e: unknown) => { result.error ??= errText(e); result.logs.push({ level: 'error', text: errText(e) }); };

  // script ends when its promise settles and no timers / sendRequest / async tests are left
  let pending = 0;
  let idle: (() => void) | undefined;
  let finished = false;
  const settle = () => { if (--pending === 0) idle?.(); };
  const timers = new Set<NodeJS.Timeout>(); // timeouts and intervals
  const immediates = new Set<NodeJS.Immediate>();

  const log = (level: string) => (...a: unknown[]) => { result.logs.push({ level, text: format(...a) }); };
  const scriptConsole = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };

  const scriptRequire = (name: string) => {
    if (Object.hasOwn(libs, name)) return libs[name];
    throw new Error(`require('${name}') is not available; allowed: ${Object.keys(libs).join(', ')}`);
  };

  // a callback returning a promise (async fn) keeps the script alive; its rejection is a script error, not an unhandled rejection
  const invoke = (fn: (...a: unknown[]) => unknown, a: unknown[]) => {
    try {
      const r = fn(...a);
      if (r instanceof Promise) { pending++; r.catch(fail).finally(settle); }
    } catch (e) { fail(e); }
  };
  // after the script finished (e.g. timed out) its leftover async code must not start timers nobody will clear
  const scriptSetTimeout = (fn: (...a: unknown[]) => unknown, ms?: number, ...a: unknown[]) => {
    if (finished) return undefined as never;
    pending++;
    const t = setTimeout(() => { timers.delete(t); invoke(fn, a); settle(); }, ms);
    timers.add(t);
    return t;
  };
  const scriptClearTimeout = (t: NodeJS.Timeout) => { if (timers.delete(t)) { clearTimeout(t); settle(); } };
  // an interval keeps the script pending until clearInterval (or the script timeout)
  const scriptSetInterval = (fn: (...a: unknown[]) => unknown, ms?: number, ...a: unknown[]) => {
    if (finished) return undefined as never;
    pending++;
    const t = setInterval(() => invoke(fn, a), ms);
    timers.add(t);
    return t;
  };
  const scriptSetImmediate = (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => {
    if (finished) return undefined as never;
    pending++;
    const t = setImmediate(() => { immediates.delete(t); invoke(fn, a); settle(); });
    immediates.add(t);
    return t;
  };
  const scriptClearImmediate = (t: NodeJS.Immediate) => { if (immediates.delete(t)) { clearImmediate(t); settle(); } };

  const s = ctx.scopes;
  const api: Record<string, unknown> = {
    environment: scopeApi(s.environment),
    collectionVariables: scopeApi(s.collection),
    globals: scopeApi(s.globals),
    variables: {
      get: (key: string) => getVar(s, key),
      has: (key: string) => getVar(s, key) !== undefined,
      set: (key: string, value: unknown) => { s.runtime[key] = String(value); },
      unset: (key: string) => { delete s.runtime[key]; },
      replaceIn: (template: string) => resolve(template, s),
    },
    request: wrapRequest(ctx.request),
    response: ctx.response && wrapResponse(ctx.response),
    info: { requestName: ctx.requestName ?? '' },
    expect: chai.expect,
    test: (name: string, fn: () => unknown) => {
      const entry: ScriptResult['tests'][number] = { name, passed: true };
      result.tests.push(entry);
      const failed = (e: unknown) => { entry.passed = false; entry.error = errText(e); };
      try {
        const r = fn();
        if (r instanceof Promise) { pending++; r.catch(failed).finally(settle); }
      } catch (e) { failed(e); }
    },
    setNextRequest: (name: string | null) => { result.nextRequest = name; },
    sendRequest: (req: string | PostmanRequest, cb?: (err: unknown, res?: unknown) => void) => {
      const prepared = toPrepared(req);
      pending++;
      const p = new Promise((ok, ko) => {
        send(prepared)
          .then((r) => {
            if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
            return wrapResponse(r.response!);
          })
          .then(
            (res) => { if (finished) return; try { cb?.(null, res); } catch (e) { fail(e); } ok(res); },
            (err) => { if (finished) return; try { cb?.(err); } catch (e) { fail(e); } if (cb) ok(undefined); else ko(err); },
          )
          .finally(settle);
      });
      p.catch(() => {}); // unawaited failure must not become an unhandled rejection; awaiting scripts still get it
      return p;
    },
  };
  const pm = new Proxy(api, {
    get: (t, p) => {
      if (typeof p !== 'string' || p in t || p === 'then') return Reflect.get(t, p);
      throw new Error(`pm.${p} is not supported`);
    },
  });

  const g = globalThis as unknown as Record<string, unknown>;
  if (activeScripts++ === 0) baseGlobals = new Set(Object.getOwnPropertyNames(g));
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    let main: Promise<unknown>;
    g[ARGS] = [pm, scriptConsole, scriptRequire, CryptoJS, scriptSetTimeout, scriptClearTimeout, scriptSetInterval, scriptClearTimeout, scriptSetImmediate, scriptClearImmediate];
    try {
      main = compile(code).runInThisContext({ timeout: SCRIPT_TIMEOUT_MS }); // hard limit for the synchronous part
    } finally {
      delete g[ARGS];
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`)), SCRIPT_TIMEOUT_MS - (Date.now() - start));
    });
    const done = (async () => {
      await main;
      while (pending > 0) await new Promise<void>((r) => { idle = r; });
    })();
    await Promise.race([done, timeout]);
  } catch (e) {
    fail(e);
  } finally {
    finished = true;
    clearTimeout(timer);
    for (const t of timers) clearTimeout(t);
    for (const t of immediates) clearImmediate(t);
    if (--activeScripts === 0) for (const k of Object.getOwnPropertyNames(g)) if (!baseGlobals.has(k)) Reflect.deleteProperty(g, k);
  }
  return result;
}
