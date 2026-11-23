// Worker entry. Role 'run': single shots (stage 1) and flows (stage 2); role 'load': one thread of a load run (stage 3).
import { setMaxListeners } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import type { FlowStatus, LoadCall, NodeStats, ResultSample, RunResult, Scopes, ScriptResult } from '../shared/api';
import type { Id, Pin } from '../shared/model';
import { emptyStats, record } from '../shared/stats';
import { CALL_SAMPLE_LIMIT, LOAD_SAMPLE_MS, LOAD_TICK_MS } from './config';
import { runFlow, type FlowInput } from './core/flow';
import { execute } from './core/http';
import { diffScopes, runRequest, type RunInput, type ScopeDiff, type Send } from './core/run';

export interface RunJob { jobId: number; input: RunInput }
export interface FlowJob { jobId: number; flow: FlowInput }
export interface CancelJob { jobId: number; cancel: true }
export type RunJobResult =
  | { jobId: number; result: Awaited<ReturnType<typeof runRequest>>; diff: ReturnType<typeof diffScopes> }
  | { jobId: number; error: string; statusCode?: number };
export type FlowJobEvent =
  | { jobId: number; event: 'start'; nodeId: Id }
  | { jobId: number; event: 'end'; nodeId: Id; outcome: Pin; result: RunResult; diff: ScopeDiff; collectionId: Id };
export interface FlowJobDone { jobId: number; status: FlowStatus; nodeRuns: number }
export type WorkerMessage = RunJobResult | FlowJobEvent | FlowJobDone;

// iterations: per VU, absent = until stop; callsPerTick: newest calls (and newest failed ones) per node one tick carries
export interface LoadWorkerData { role: 'load'; input: FlowInput; vus: number; firstVu: number; iterations?: number; callsPerTick: number }
export type TickCall = Omit<LoadCall, 'seq'> & { sample: ResultSample }; // the main thread numbers them
// deltas since the previous tick; calls: per node the newest callsPerTick calls plus the newest callsPerTick failed ones, oldest first
export interface LoadTick { iterations: number; failedIterations: number; nodes: Record<Id, NodeStats>; calls: Record<Id, TickCall[]>; done?: true }
const SAMPLE_BODY_LIMIT = 64 * 1024;
// a plain slice can be a V8 sliced string that keeps the whole (up to 10 MB) parent alive; force a copy
const cut = (s: string, n: number) => Buffer.from(s.slice(0, n)).toString();

/** Copy without scopes; response body, request body and the logs of all scripts together are each cut at limit. */
function sample(r: RunResult, limit = SAMPLE_BODY_LIMIT): ResultSample {
  const { scopes: _, ...rest } = r;
  let truncated = false;
  let budget = limit;
  const cutLogs = (scripts: ScriptResult[]) => scripts.map((sr) => {
    const logs: ScriptResult['logs'] = [];
    for (const l of sr.logs) {
      if (budget <= 0) { truncated = true; break; }
      if (l.text.length > budget) truncated = true;
      logs.push(l.text.length > budget ? { ...l, text: cut(l.text, budget) } : l);
      budget -= l.text.length;
    }
    return { ...sr, logs };
  });
  const out: ResultSample = { ...rest, preScripts: cutLogs(r.preScripts), testScripts: cutLogs(r.testScripts) };
  const body = r.finalRequest.body;
  if (body && body.length > limit) { out.finalRequest = { ...r.finalRequest, body: cut(body, limit) }; truncated = true; }
  const res = r.response;
  if (res && res.body.length > limit) out.response = { ...res, body: cut(res.body, limit), truncated: true };
  if (truncated) out.truncated = true;
  return out;
}

if (parentPort && workerData?.role === 'run') {
  const port = parentPort;
  const flows = new Map<number, AbortController>();
  // safety net: a stray rejection from a user script must not kill the worker and every job in it
  process.on('unhandledRejection', (e) => console.error(e));
  port.on('message', async (m: RunJob | FlowJob | CancelJob) => {
    const { jobId } = m;
    if ('cancel' in m) return flows.get(jobId)?.abort();
    try {
      if ('flow' in m) {
        const ac = new AbortController();
        flows.set(jobId, ac);
        let before: Scopes | undefined;
        const out = await runFlow(m.flow, {
          signal: ac.signal,
          onNodeStart: (node, scopes) => {
            before = structuredClone(scopes);
            port.postMessage({ jobId, event: 'start', nodeId: node.id } satisfies FlowJobEvent);
          },
          onNodeEnd: (node, result, outcome, scopes) => {
            const collectionId = node.type === 'request' ? node.data.collectionId : '';
            port.postMessage({ jobId, event: 'end', nodeId: node.id, outcome, result, diff: diffScopes(before!, scopes), collectionId } satisfies FlowJobEvent);
          },
        });
        port.postMessage({ jobId, ...out } satisfies FlowJobDone);
        return;
      }
      const before = structuredClone(m.input.scopes);
      const result = await runRequest(m.input);
      port.postMessage({ jobId, result, diff: diffScopes(before, result.scopes) } satisfies RunJobResult);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      port.postMessage({ jobId, error: err.message, statusCode: err.statusCode } satisfies RunJobResult);
    } finally {
      flows.delete(jobId);
    }
  });
}

if (parentPort && workerData?.role === 'load') {
  const port = parentPort;
  const { input, vus, firstVu, iterations = Infinity, callsPerTick } = workerData as LoadWorkerData;
  process.on('unhandledRejection', (e) => console.error(e));
  const ac = new AbortController();
  setMaxListeners(0, ac.signal); // every VU's requests and timers listen on it
  port.on('message', () => ac.abort()); // the only message is stop
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  const send: Send = (req, opts) => execute(req, { ...opts, agents });
  let tick: LoadTick = { iterations: 0, failedIterations: 0, nodes: {}, calls: {} };
  // newest results per node; samples (up to 64 KB each) are built at most every LOAD_SAMPLE_MS and in the final tick
  const raw = new Map<Id, { last: RunResult; lastError?: RunResult }>();
  const sampledAt = new Map<Id, number>();
  type Pending = { n: number; call: TickCall }; // sample built right away, so no full result (up to 10 MB) waits for the tick
  const pending = new Map<Id, { recent: Pending[]; failed: Pending[] }>();
  const keep = (a: Pending[], p: Pending) => { a.push(p); if (a.length > callsPerTick) a.shift(); };
  let n = 0;
  const flush = (done?: true) => {
    const now = Date.now();
    for (const [id, { last, lastError }] of raw) {
      if (!done && now - (sampledAt.get(id) ?? 0) < LOAD_SAMPLE_MS) continue;
      const s = (tick.nodes[id] ??= emptyStats()); // may have no calls in this tick; merge still copies the samples
      s.last = sample(last);
      if (lastError) s.lastError = lastError === last ? s.last : sample(lastError);
      sampledAt.set(id, now);
      raw.delete(id);
    }
    for (const [id, { recent, failed }] of pending) {
      tick.calls[id] = [...new Set([...failed, ...recent])].sort((a, b) => a.n - b.n).map((p) => p.call);
    }
    pending.clear();
    port.postMessage({ ...tick, done } satisfies LoadTick);
    tick = { iterations: 0, failedIterations: 0, nodes: {}, calls: {} };
  };
  const timer = setInterval(flush, LOAD_TICK_MS);
  const vu = async (vuNo: number) => {
    const scopes = structuredClone(input.scopes); // tokens stay within the VU, nothing is written back
    for (let iteration = 1; iteration <= iterations && !ac.signal.aborted; iteration++) {
      scopes.runtime = {};
      let started = 0, at = 0, failed = false;
      const out = await runFlow({ ...input, scopes }, {
        signal: ac.signal,
        onNodeStart: () => { started = performance.now(); at = Date.now(); },
        onNodeEnd: (node, result, outcome) => {
          if (ac.signal.aborted) return; // cancelled requests are not failures of the target
          const s = (tick.nodes[node.id] ??= emptyStats());
          const ms = performance.now() - started;
          const status = result.response?.status;
          const code = status === undefined ? result.error?.code ?? 'ERROR' : undefined;
          record(s, ms, outcome === 'ok', code ?? String(status));
          const p: Pending = { n: n++, call: { vu: vuNo, iteration, at, status, code, ms, outcome, sample: sample(result, CALL_SAMPLE_LIMIT) } };
          const q = pending.get(node.id) ?? { recent: [], failed: [] };
          keep(q.recent, p);
          if (outcome === 'fail') keep(q.failed, p);
          pending.set(node.id, q);
          const r = raw.get(node.id) ?? { last: result };
          r.last = result;
          if (outcome === 'fail') { r.lastError = result; failed = true; }
          raw.set(node.id, r);
        },
      }, send);
      if (out.status !== 'cancelled') { tick.iterations++; if (failed) tick.failedIterations++; }
      await new Promise(setImmediate); // an iteration without I/O (e.g. an empty flow) must not starve the tick timer and stop
    }
  };
  void Promise.all(Array.from({ length: vus }, (_, i) => vu(firstVu + i).catch((e) => console.error(e)))).finally(() => {
    clearInterval(timer);
    flush(true);
    agents.http.destroy();
    agents.https.destroy();
  });
}
