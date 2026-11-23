import { expect, test } from 'vitest';
import type { Scopes } from '../../shared/api';
import { getVar, resolve } from './variables';

const v = (key: string, value: string, enabled = true) => ({ key, value, enabled });
const scopes = (p: Partial<Scopes> = {}): Scopes => ({ runtime: {}, environment: [], collection: [], globals: [], ...p });

test('precedence runtime>env>collection>globals', () => {
  const s = scopes({
    runtime: { a: 'runtime' },
    environment: [v('a', 'env'), v('b', 'env')],
    collection: [v('a', 'col'), v('b', 'col'), v('c', 'col')],
    globals: [v('a', 'glob'), v('b', 'glob'), v('c', 'glob'), v('d', 'glob')],
  });
  expect(resolve('{{a}} {{b}} {{c}} {{d}}', s)).toBe('runtime env col glob');
});

test('ignores disabled', () => {
  const s = scopes({ environment: [v('a', 'env', false)], globals: [v('a', 'glob')] });
  expect(getVar(s, 'a')).toBe('glob');
  expect(getVar(scopes({ environment: [v('x', '1', false)] }), 'x')).toBeUndefined();
});

test('recursive depth limit', () => {
  const chain = (n: number, last: string) =>
    scopes({ environment: Array.from({ length: n }, (_, i) => v(`v${i + 1}`, i + 1 < n ? `{{v${i + 2}}}` : last)) });
  expect(resolve('{{v1}}', chain(10, 'end'))).toBe('end');
  expect(resolve('{{v1}}', chain(11, 'end'))).toBe('{{v11}}');
  expect(resolve('x{{self}}', scopes({ environment: [v('self', '{{self}}')] }))).toBe('x{{self}}');
});

test('unresolved kept', () => {
  expect(resolve('{{host}}/{{missing}}/{{ $nope }}', scopes({ environment: [v('host', 'h')] }))).toBe('h/{{missing}}/{{ $nope }}');
});

test('dynamic vars fresh per occurrence', () => {
  const [a, b] = resolve('{{$guid}} {{$randomUUID}}', scopes()).split(' ');
  expect(a).toMatch(/^[0-9a-f-]{36}$/);
  expect(a).not.toBe(b);
  expect(new Set(resolve('{{$guid}},{{$guid}},{{$guid}}', scopes()).split(',')).size).toBe(3);
  expect(Number(resolve('{{$timestamp}}', scopes()))).toBeCloseTo(Date.now() / 1000, -1);
  expect(Date.parse(resolve('{{$isoTimestamp}}', scopes()))).not.toBeNaN();
  for (const n of resolve('{{$randomInt}},'.repeat(50), scopes()).split(',').slice(0, -1).map(Number)) {
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1000);
  }
});

test('Postman dynamic vars formats', () => {
  const r = (n: string) => resolve(`{{${n}}}`, scopes());
  expect(r('$randomAlphaNumeric')).toMatch(/^[a-zA-Z0-9]$/);
  expect(r('$randomBoolean')).toMatch(/^(true|false)$/);
  expect(r('$randomHexColor')).toMatch(/^#[0-9a-f]{6}$/);
  expect(r('$randomIP')).toMatch(/^(\d{1,3}\.){3}\d{1,3}$/);
  expect(r('$randomIPV6')).toMatch(/^([0-9a-f]{4}:){7}[0-9a-f]{4}$/);
  expect(r('$randomMACAddress')).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  expect(r('$randomPassword')).toMatch(/^[a-zA-Z0-9]{15}$/);
  expect(r('$randomEmail')).toMatch(/^[\w.]+@\w+\.\w+$/);
  expect(r('$randomExampleEmail')).toMatch(/@example\.(com|net|org)$/);
  expect(r('$randomUrl')).toMatch(/^https:\/\/\w+\.\w+$/);
  expect(r('$randomFullName')).toMatch(/^\w+ \w+$/);
  expect(r('$randomLoremSentence')).toMatch(/^[A-Z][a-z ]+\.$/);
  expect(r('$randomPrice')).toMatch(/^\d+\.\d{2}$/);
  expect(r('$randomCountryCode')).toMatch(/^[A-Z]{2}$/);
  expect(Date.parse(r('$randomDatePast'))).toBeLessThan(Date.now());
  expect(Date.parse(r('$randomDateFuture'))).toBeGreaterThan(Date.now());
  expect(r('$randomNope')).toBe('{{$randomNope}}');
});
