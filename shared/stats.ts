import type { NodeStats } from './api';

// log buckets 2% wide from 0.01 ms: bucket i holds (MIN*STEP^(i-1), MIN*STEP^i], reported as its geometric middle (error <= 1%)
const MIN = 0.01;
const STEP = 1.02;
const LOG_STEP = Math.log(STEP);
const bucket = (ms: number) => (ms <= MIN ? 0 : Math.ceil(Math.log(ms / MIN) / LOG_STEP));
const bucketValue = (i: number) => MIN * STEP ** (i - 0.5);

export const emptyStats = (): NodeStats => ({ count: 0, ok: 0, fail: 0, sum: 0, min: 0, max: 0, hist: {}, codes: {} });

export function record(s: NodeStats, ms: number, ok: boolean, code: string): void {
  s.min = s.count ? Math.min(s.min, ms) : ms;
  s.max = s.count ? Math.max(s.max, ms) : ms;
  s.count++;
  if (ok) s.ok++;
  else s.fail++;
  s.sum += ms;
  const b = bucket(ms);
  s.hist[b] = (s.hist[b] ?? 0) + 1;
  s.codes[code] = (s.codes[code] ?? 0) + 1;
}

/** Adds `from` into `into` (the newer samples win) and returns `into`, so it works as a reducer for a Total. */
export function merge(into: NodeStats, from: NodeStats): NodeStats {
  // a load tick can carry a node's deferred samples without new calls
  if (from.last) into.last = from.last;
  if (from.lastError) into.lastError = from.lastError;
  if (!from.count) return into;
  into.min = into.count ? Math.min(into.min, from.min) : from.min;
  into.max = into.count ? Math.max(into.max, from.max) : from.max;
  into.count += from.count;
  into.ok += from.ok;
  into.fail += from.fail;
  into.sum += from.sum;
  for (const [k, n] of Object.entries(from.hist)) into.hist[Number(k)] = (into.hist[Number(k)] ?? 0) + n;
  for (const [k, n] of Object.entries(from.codes)) into.codes[k] = (into.codes[k] ?? 0) + n;
  return into;
}

/** p in 0..100; 0 when empty. */
export function percentile(s: NodeStats, p: number): number {
  if (!s.count) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * s.count));
  let seen = 0;
  for (const k of Object.keys(s.hist).map(Number).sort((a, b) => a - b)) {
    seen += s.hist[k];
    if (seen >= rank) return Math.min(s.max, Math.max(s.min, bucketValue(k)));
  }
  return s.max;
}

export function summary(s: NodeStats) {
  return {
    count: s.count, ok: s.ok, fail: s.fail,
    errPct: s.count ? (100 * s.fail) / s.count : 0,
    min: s.min, avg: s.count ? s.sum / s.count : 0, p50: percentile(s, 50), p95: percentile(s, 95), max: s.max,
  };
}
