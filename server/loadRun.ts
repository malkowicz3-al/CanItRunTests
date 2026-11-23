import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { FlowStatus, LoadCall, NodeStats, ResultSample } from '../shared/api';
import type { Id } from '../shared/model';
import { emptyStats, merge } from '../shared/stats';
import { CALLS_KEPT, FAILED_CALLS_KEPT, LOAD_TICK_MS, MAX_DURATION_MIN, SCRIPT_TIMEOUT_MS } from './config';
import type { FlowInput } from './core/flow';
import type { LoadTick, LoadWorkerData } from './worker';

const STALL_MS = 15_000;

export type KeptCall = LoadCall & { sample: ResultSample };
// cumulative; calls: per node the newest CALLS_KEPT calls and the newest FAILED_CALLS_KEPT failed ones, oldest first
export interface LoadTotals { iterations: number; failedIterations: number; nodes: Record<Id, NodeStats>; calls: Record<Id, { all: KeptCall[]; failed: KeptCall[] }> }
export interface LoadHandle { done: Promise<FlowStatus>; stop(): void; totals: LoadTotals } // totals: live, updated in place

/**
 * Spreads the VUs over up to 4 worker threads (one core left for the server) and merges their deltas (every LOAD_TICK_MS).
 * opts.iterations is per VU (absent = until stop).
 * onTick gets the totals every LOAD_TICK_MS and once more at the end (final); done is 'done', 'cancelled' (stop) or 'limit' (max duration).
 * stallMs / maxDurationMs / killMs override the defaults (tests).
 */
export function startLoad(
  input: FlowInput,
  opts: { vus: number; iterations?: number; stallMs?: number; maxDurationMs?: number; killMs?: number },
  workerFile: string,
  onTick: (t: LoadTotals, final?: true) => void,
): LoadHandle {
  const { stallMs = STALL_MS, maxDurationMs = MAX_DURATION_MIN * 60_000, killMs = SCRIPT_TIMEOUT_MS + 1000 } = opts;
  const n = Math.max(1, Math.min(opts.vus, os.availableParallelism() - 1, 4));
  const vus = Array.from({ length: n }, (_, i) => Math.floor(opts.vus / n) + (i < opts.vus % n ? 1 : 0));
  const totals: LoadTotals = { iterations: 0, failedIterations: 0, nodes: {}, calls: {} };
  let seq = 0;
  const keep = (a: KeptCall[], c: KeptCall, max: number) => { a.push(c); if (a.length > max) a.shift(); };
  let status: FlowStatus = 'done';
  let stopping = false, ended = false;
  let ok!: (s: FlowStatus) => void, ko!: (e: Error) => void;
  const done = new Promise<FlowStatus>((a, b) => { ok = a; ko = b; });

  const workers = Array.from({ length: n }, (_, i) => {
    const data: LoadWorkerData = { role: 'load', input, vus: vus[i], firstVu: 1 + vus.slice(0, i).reduce((a, b) => a + b, 0), iterations: opts.iterations, callsPerTick: Math.ceil(CALLS_KEPT / n) };
    const w = { thread: new Worker(workerFile, { workerData: data }), seen: Date.now(), finished: false };
    w.thread.on('message', (m: LoadTick) => {
      if (ended) return;
      w.seen = Date.now();
      totals.iterations += m.iterations;
      totals.failedIterations += m.failedIterations;
      for (const [id, s] of Object.entries(m.nodes)) merge((totals.nodes[id] ??= emptyStats()), s);
      for (const [id, calls] of Object.entries(m.calls)) {
        const kept = (totals.calls[id] ??= { all: [], failed: [] });
        for (const c of calls) {
          const k = { seq: ++seq, ...c };
          keep(kept.all, k, CALLS_KEPT);
          if (k.outcome === 'fail') keep(kept.failed, k, FAILED_CALLS_KEPT);
        }
      }
      if (!m.done) return;
      w.finished = true;
      void w.thread.terminate();
      if (workers.every((x) => x.finished)) end();
    });
    w.thread.on('error', (e) => end(e));
    w.thread.on('exit', (code) => { if (!w.finished) end(new Error(`Load worker exited with code ${code}`)); });
    return w;
  });

  const ticker = setInterval(() => {
    if (workers.some((w) => !w.finished && Date.now() - w.seen > stallMs)) return end(new Error(`Load worker stalled (no stats for ${stallMs / 1000} s)`));
    onTick(totals);
  }, LOAD_TICK_MS);
  const maxDuration = setTimeout(() => stop('limit'), maxDurationMs);
  let kill: NodeJS.Timeout | undefined;

  function end(err?: Error) {
    if (ended) return;
    ended = true;
    clearInterval(ticker);
    clearTimeout(maxDuration);
    clearTimeout(kill);
    for (const w of workers) { w.finished = true; void w.thread.terminate(); }
    onTick(totals, true);
    if (err) ko(err);
    else ok(status);
  }

  function stop(why: FlowStatus = 'cancelled') {
    if (stopping || ended) return;
    stopping = true;
    status = why;
    for (const w of workers) if (!w.finished) w.thread.postMessage('stop');
    kill = setTimeout(() => end(), killMs); // a running script ends by itself within its timeout
  }

  return { done, stop: () => stop(), totals };
}
