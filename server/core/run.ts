import type { PreparedRequest, RunResult, Scopes, ScriptResult } from '../../shared/api';
import type { Collection, Environment, Id, RequestItem, Variable } from '../../shared/model';
import { HTTP_TIMEOUT_MS } from '../config';
import { execute, type HttpOptions, type HttpResult } from './http';
import { finalize, prepare, template } from './prepare';
import { runScript } from './sandbox';
import { resolve } from './variables';

export interface RunInput {
  collection: Collection;
  requestId: Id;
  override?: RequestItem; // unsaved editor state
  scopes: Scopes; // mutated in place
  env?: Environment;
  signal?: AbortSignal;
}

export type Send = (req: PreparedRequest, opts: HttpOptions) => Promise<HttpResult>;

export async function runRequest(input: RunInput, send: Send = execute): Promise<RunResult> {
  const { scopes, env } = input;
  const p = prepare(input.collection, input.requestId, input.override);
  const c = env?.clientCert;
  const clientCert = c && { cert: resolve(c.cert, scopes), key: resolve(c.key, scopes), passphrase: c.passphrase && resolve(c.passphrase, scopes), ca: c.ca && resolve(c.ca, scopes) };
  const opts: HttpOptions = {
    ignoreTls: env?.ignoreTls ?? false,
    clientCert,
    timeoutMs: HTTP_TIMEOUT_MS,
    followRedirects: p.item.followRedirects ?? env?.followRedirects ?? true,
    signal: input.signal,
  };
  const scriptSend = (r: PreparedRequest) => send(r, opts);
  const info = { requestName: p.item.name, requestId: p.item.id, environmentName: env?.name, bodyMode: p.item.body.mode };
  const nextOf = (rs: ScriptResult[]) => rs.reduce<string | null | undefined>((n, x) => (x.nextRequest !== undefined ? x.nextRequest : n), undefined);

  const request = template(p.item);
  const preScripts: ScriptResult[] = [];
  for (const code of p.pre) {
    if (input.signal?.aborted) return { finalRequest: finalize(p, request, scopes), redirects: [], error: { code: 'ECANCELED', message: 'Cancelled' }, preScripts, testScripts: [], scopes, nextRequest: nextOf(preScripts) };
    const res = await runScript(code, { scopes, request, ...info, send: scriptSend });
    preScripts.push(res);
    if (res.error) {
      // like Postman: a failing pre-request script cancels the request
      return { finalRequest: finalize(p, request, scopes), redirects: [], error: { code: 'ESCRIPT', message: `Pre-request script failed: ${res.error}` }, preScripts, testScripts: [], scopes, nextRequest: nextOf(preScripts) };
    }
    if (res.skipped) return { finalRequest: finalize(p, request, scopes), redirects: [], error: { code: 'ESKIPPED', message: 'Request skipped by pre-request script' }, preScripts, testScripts: [], scopes, nextRequest: nextOf(preScripts) };
  }

  const http = await send(finalize(p, request, scopes), opts);
  const testScripts: ScriptResult[] = [];
  if (http.response) {
    for (const code of p.test) {
      if (input.signal?.aborted) break;
      testScripts.push(await runScript(code, { scopes, request: { ...http.finalRequest, headers: { ...http.finalRequest.headers } }, response: http.response, ...info, send: scriptSend }));
    }
  }
  return { ...http, preScripts, testScripts, scopes, nextRequest: nextOf([...preScripts, ...testScripts]) };
}

export type ScopeDiff = Partial<Record<'environment' | 'collection' | 'globals', { set: Variable[]; unset: string[] }>>;

/** Per-key changes of the persisted scopes; only these get applied to the files after a run, so concurrent edits survive. */
export function diffScopes(before: Scopes, after: Scopes): ScopeDiff {
  const diff: ScopeDiff = {};
  for (const k of ['environment', 'collection', 'globals'] as const) {
    const old = new Map(before[k].map((v) => [v.key, JSON.stringify(v)]));
    const set = after[k].filter((v) => old.get(v.key) !== JSON.stringify(v));
    const keys = new Set(after[k].map((v) => v.key));
    const unset = [...old.keys()].filter((key) => !keys.has(key));
    if (set.length || unset.length) diff[k] = { set, unset };
  }
  return diff;
}

export function applyDiff(list: Variable[], d: { set: Variable[]; unset: string[] }): Variable[] {
  const out = list.filter((v) => !d.unset.includes(v.key));
  for (const v of d.set) {
    const i = out.findIndex((x) => x.key === v.key);
    if (i >= 0) out[i] = v;
    else out.push(v);
  }
  return out;
}
