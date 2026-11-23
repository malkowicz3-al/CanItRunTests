import crypto from 'node:crypto';
import { format } from 'node:util';
import vm from 'node:vm';
import chai from 'chai';
import CryptoJS from 'crypto-js';
// Static import so esbuild rewrites ESM-only jose into the CJS bundle.
import * as jose from 'jose';
import jsrsasign from 'jsrsasign';
import _ from 'lodash';
import moment from 'moment';
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
  requestId?: string;
  environmentName?: string;
  bodyMode?: string; // pm.request.body.mode
  send?: (req: PreparedRequest) => Promise<HttpResult>; // pm.sendRequest
}

const ARGS = '__citrScriptArgs';
const libs: Record<string, unknown> = { crypto, jose, jsrsasign, 'crypto-js': CryptoJS, lodash: _, moment, uuid: { v4: () => crypto.randomUUID() }, chai, atob, btoa };
const cache = new Map<string, vm.Script>();

function compile(code: string): vm.Script {
  let script = cache.get(code);
  if (!script) {
    if (cache.size >= 500) cache.clear(); // shortcut: crude bound for edited scripts in a long-lived worker, LRU if it matters
    // user code starts on line 1 so stack traces keep its line numbers; the inner block lets `const _ = require('lodash')` shadow a parameter
    script = new vm.Script(
      `(async function (pm, console, require, CryptoJS, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, postman, tests, responseBody, responseCode, responseTime, responseHeaders, environment, globals, data, request, _) {{${code}\n}}).apply(undefined, globalThis.${ARGS})`,
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

const toObject = (list: Variable[]) => Object.fromEntries(list.filter((v) => v.enabled).map((v) => [v.key, v.value]));

function scopeApi(list: Variable[], s: Scopes) {
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
    clear: () => { list.length = 0; },
    toObject: () => toObject(list),
    replaceIn: (template: string) => resolve(template, s),
  };
}

// regex instead of new URL: the url may still contain unresolved {{vars}}
const URL_PARTS = /^(?:[a-z][\w+.-]*:\/\/)?([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;

function wrapRequest(req: PreparedRequest, bodyMode?: string) {
  const find = (k: string) => Object.keys(req.headers).find((h) => h.toLowerCase() === k.toLowerCase());
  const remove = (k: string) => { const h = find(k); if (h !== undefined) delete req.headers[h]; };
  const upsert = (h: { key: string; value: unknown }) => { remove(h.key); req.headers[h.key] = String(h.value); };
  return {
    get method() { return req.method; },
    set method(m: string) { req.method = m; },
    get url() {
      const [, host, path, query] = URL_PARTS.exec(req.url)!;
      return { toString: () => req.url, getHost: () => host.replace(/^[^@]*@/, '').replace(/:\d+$/, ''), getPath: () => path || '/', getQueryString: () => query ?? '' };
    },
    set url(u: unknown) { req.url = String(u); },
    headers: { get: (k: string) => { const h = find(k); return h === undefined ? undefined : req.headers[h]; }, add: upsert, upsert, remove, has: (k: string) => find(k) !== undefined,
      each: (fn: (h: { key: string; value: string }) => void) => { for (const [key, value] of Object.entries(req.headers)) fn({ key, value }); }, toObject: () => ({ ...req.headers }) },
    body: { mode: bodyMode, get raw() { return req.body ?? ''; }, set raw(v: unknown) { req.body = String(v); }, toString: () => req.body ?? '' },
  };
}

// unknown props throw instead of silently passing as undefined (like the pm Proxy)
const strict = <T extends object>(o: T): T => new Proxy(o, {
  get: (t, p) => {
    if (typeof p !== 'string' || p in t || p === 'then') return Reflect.get(t, p);
    throw new Error(`pm.response.to.${p} is not supported`);
  },
});

const headerOf = (r: HttpResponse) => (k: string) => { const v = r.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v; };

// Postman's chai-style `pm.response.to...`; `be.*` assert on property access
function responseTo(r: HttpResponse, neg = false): unknown {
  const assert = (ok: boolean, what: string, got: string) => {
    if (ok === neg) throw new chai.AssertionError(`expected response ${neg ? 'not ' : ''}to ${what}, got ${got}`);
  };
  const header = headerOf(r);
  const code = `status ${r.status}`;
  const parsed = () => { try { return { v: JSON.parse(r.body) as unknown }; } catch { return undefined; } };
  const range = (lo: number, hi: number, what: string) => { assert(r.status >= lo && r.status <= hi, what, code); return true; };
  return strict({
    get not() { return responseTo(r, !neg); },
    have: strict({
      status: (s: number | string) => (typeof s === 'number' ? assert(r.status === s, `have status ${s}`, code) : assert(r.statusText === s, `have status '${s}'`, `'${r.statusText}'`)),
      header: (name: string, value?: unknown) => {
        const h = header(name);
        assert(h !== undefined && (value === undefined || h === String(value)), value === undefined ? `have header '${name}'` : `have header '${name}: ${value}'`, h === undefined ? 'no such header' : `'${h}'`);
      },
      body: (text?: string) => assert(text === undefined ? r.body !== '' : r.body === text, text === undefined ? 'have a body' : `have body '${text}'`, `'${r.body.slice(0, 200)}'`),
      // rest args: an explicit `undefined` value still has to match
      jsonBody: (...a: [path?: string, value?: unknown]) => {
        const [path, value] = a;
        const p = parsed();
        const ok = p !== undefined && (path === undefined || (_.has(p.v, path) && (a.length < 2 || _.isEqual(_.get(p.v, path), value))));
        const what = path === undefined ? 'have a JSON body' : a.length < 2 ? `have JSON body with '${path}'` : `have JSON body with '${path}' = ${JSON.stringify(value)}`;
        assert(ok, what, p === undefined ? 'invalid JSON' : `'${r.body.slice(0, 200)}'`);
      },
    }),
    be: strict({
      get info() { return range(100, 199, 'be info (1xx)'); },
      get ok() { return range(200, 200, 'be ok (200)'); },
      get accepted() { return range(202, 202, 'be accepted (202)'); },
      get redirection() { return range(300, 399, 'be a redirection (3xx)'); },
      get badRequest() { return range(400, 400, 'be a bad request (400)'); },
      get unauthorized() { return range(401, 401, 'be unauthorized (401)'); },
      get forbidden() { return range(403, 403, 'be forbidden (403)'); },
      get notFound() { return range(404, 404, 'be not found (404)'); },
      get rateLimited() { return range(429, 429, 'be rate limited (429)'); },
      get success() { return range(200, 299, 'be success (2xx)'); },
      get error() { return range(400, 599, 'be an error (4xx/5xx)'); },
      get clientError() { return range(400, 499, 'be a client error (4xx)'); },
      get serverError() { return range(500, 599, 'be a server error (5xx)'); },
      get json() { assert(/json/i.test(header('content-type') ?? '') && parsed() !== undefined, 'be JSON', `content-type '${header('content-type') ?? ''}'`); return true; },
      get withBody() { assert(r.body !== '', 'have a body', 'empty body'); return true; },
    }),
  });
}

function wrapResponse(r: HttpResponse) {
  const header = headerOf(r);
  return {
    code: r.status,
    status: r.statusText,
    reason: () => r.statusText,
    responseTime: r.timings.total,
    responseSize: Buffer.byteLength(r.body),
    headers: { get: header, has: (k: string) => header(k) !== undefined, toObject: () => ({ ...r.headers }) },
    text: () => r.body,
    json: () => JSON.parse(r.body),
    to: responseTo(r),
  };
}

function cookiesOf(r?: HttpResponse): Record<string, string> {
  const raw = r?.headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return Object.fromEntries(list.map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
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
  const env = scopeApi(s.environment, s);
  const glob = scopeApi(s.globals, s);
  const setNextRequest = (name: string | null) => { result.nextRequest = name; };
  const cookies = cookiesOf(ctx.response);
  const api: Record<string, unknown> = {
    environment: { ...env, name: ctx.environmentName },
    collectionVariables: scopeApi(s.collection, s),
    globals: glob,
    variables: {
      toObject: () => ({ ...toObject(s.globals), ...toObject(s.collection), ...toObject(s.environment), ...s.runtime }),
      get: (key: string) => getVar(s, key),
      has: (key: string) => getVar(s, key) !== undefined,
      set: (key: string, value: unknown) => { s.runtime[key] = String(value); },
      unset: (key: string) => { delete s.runtime[key]; },
      replaceIn: (template: string) => resolve(template, s),
    },
    request: wrapRequest(ctx.request, ctx.bodyMode),
    response: ctx.response && wrapResponse(ctx.response),
    info: { requestName: ctx.requestName ?? '', requestId: ctx.requestId ?? '', eventName: ctx.response ? 'test' : 'prerequest', iteration: 0, iterationCount: 1 },
    execution: { setNextRequest, skipRequest: () => {
      if (ctx.response) scriptConsole.warn('pm.execution.skipRequest() only works in pre-request scripts');
      else result.skipped = true;
    } },
    iterationData: { get: () => undefined, has: () => false, toObject: () => ({}) },
    cookies: { get: (k: string) => cookies[k], has: (k: string) => Object.hasOwn(cookies, k), toObject: () => ({ ...cookies }) },
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
    setNextRequest,
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

  // legacy (pre-pm) Postman API
  const postman = {
    setEnvironmentVariable: env.set, getEnvironmentVariable: env.get, clearEnvironmentVariable: env.unset,
    setGlobalVariable: glob.set, getGlobalVariable: glob.get, clearGlobalVariable: glob.unset, setNextRequest,
    getResponseHeader: (name: string) => (ctx.response ? headerOf(ctx.response)(name) : undefined),
    getResponseCookie: (name: string) => (Object.hasOwn(cookies, name) ? { name, value: cookies[name] } : undefined),
  };
  const tests: Record<string, unknown> = {};
  const r = ctx.response;
  const legacyRequest = { url: ctx.request.url, method: ctx.request.method, headers: { ...ctx.request.headers }, data: ctx.request.body };
  const legacy = [postman, tests, r?.body, r && { code: r.status, name: r.statusText, detail: r.statusText }, r?.timings.total,
    r && new Proxy(Object.fromEntries(Object.keys(r.headers).map((k) => [k, headerOf(r)(k)])), { get: (t, p) => Reflect.get(t, typeof p === 'string' ? p.toLowerCase() : p) }), toObject(s.environment), toObject(s.globals), {}, legacyRequest, _];

  const g = globalThis as unknown as Record<string, unknown>;
  if (activeScripts++ === 0) baseGlobals = new Set(Object.getOwnPropertyNames(g));
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    let main: Promise<unknown>;
    g[ARGS] = [pm, scriptConsole, scriptRequire, CryptoJS, scriptSetTimeout, scriptClearTimeout, scriptSetInterval, scriptClearTimeout, scriptSetImmediate, scriptClearImmediate, ...legacy];
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
  for (const [name, v] of Object.entries(tests)) result.tests.push({ name, passed: !!v });
  return result;
}
