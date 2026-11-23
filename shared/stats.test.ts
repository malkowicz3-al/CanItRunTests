import { expect, test } from 'vitest';
import { emptyStats, merge, percentile, record, summary } from './stats';

const exact = (sorted: number[], p: number) => sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];

test('p50/p95 within 2% of exact on a skewed sample', () => {
  const s = emptyStats();
  const values = Array.from({ length: 10_000 }, (_, i) => 0.5 + ((i * 7919) % 10_000) ** 2 / 50_000); // 0.5 .. ~2000 ms
  for (const v of values) record(s, v, true, '200');
  const sorted = [...values].sort((a, b) => a - b);
  for (const p of [50, 95, 99]) expect(Math.abs(percentile(s, p) / exact(sorted, p) - 1)).toBeLessThan(0.02);
  expect(s.min).toBe(sorted[0]);
  expect(s.max).toBe(sorted.at(-1));
});

test('merge equals recording everything into one', () => {
  const a = emptyStats(), b = emptyStats(), joint = emptyStats();
  for (let i = 0; i < 300; i++) {
    const [v, ok, code] = [1 + i * 3.3, i % 7 !== 0, i % 7 ? '200' : 'ECONNREFUSED'] as const;
    record(i % 2 ? a : b, v, ok, code);
    record(joint, v, ok, code);
  }
  const merged = merge(merge(emptyStats(), a), b);
  expect({ ...merged, sum: Math.round(merged.sum) }).toEqual({ ...joint, sum: Math.round(joint.sum) });
  expect(summary(merged)).toMatchObject({ count: 300, fail: 43, p50: percentile(joint, 50) });
});

test('edge cases: empty, single value, merge of empty, samples', () => {
  const e = emptyStats();
  expect(summary(e)).toEqual({ count: 0, ok: 0, fail: 0, errPct: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 });
  const one = emptyStats();
  record(one, 42, false, '500');
  expect(summary(one)).toMatchObject({ min: 42, max: 42, p50: 42, p95: 42, errPct: 100 });
  record(one, 0, true, '200'); // 0 ms goes to the lowest bucket
  expect(percentile(one, 1)).toBeLessThan(0.011);
  expect(merge(emptyStats(), e)).toEqual(emptyStats());
  const last = { finalRequest: { method: 'GET', url: 'u', headers: {} }, redirects: [], preScripts: [], testScripts: [] };
  expect(merge(one, { ...emptyStats(), count: 1, ok: 1, max: 1, min: 1, sum: 1, hist: { 0: 1 }, last }).last).toBe(last);
  expect(merge(emptyStats(), { ...emptyStats(), last })).toEqual({ ...emptyStats(), last }); // deferred samples without new calls
});
