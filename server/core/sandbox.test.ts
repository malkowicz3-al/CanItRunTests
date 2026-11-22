import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Scopes } from '../../shared/api';
import { startMockServer } from '../../test/mockServer';
import { runScript, type ScriptCtx } from './sandbox';

let mock: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => { mock = await startMockServer(); });
afterAll(() => mock.close());

const v = (key: string, value: string) => ({ key, value, enabled: true });
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function ctx(p: Partial<Scopes> = {}): ScriptCtx & { scopes: Scopes } {
  return {
    scopes: { runtime: {}, environment: [v('key', privateKey)], collection: [], globals: [], ...p },
    request: { method: 'GET', url: 'http://x/', headers: {} },
  };
}

function verifyRs256(jws: string) {
  const [h, p, sig] = jws.split('.');
  expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'RS256' });
  expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
}

test('env get/set mutates scopes', async () => {
  const c = ctx({ environment: [v('a', '1')], collection: [v('c', 'col')], globals: [] });
  const r = await runScript(`
    pm.environment.set('a', Number(pm.environment.get('a')) + 1);
    pm.environment.set('b', 'new');
    pm.collectionVariables.set('c', pm.collectionVariables.get('c') + '!');
    pm.globals.set('g', pm.environment.has('b'));
    pm.environment.unset('missing');
  `, c);
  expect(r.error).toBeUndefined();
  expect(c.scopes.environment).toEqual([v('a', '2'), v('b', 'new')]);
  expect(c.scopes.collection).toEqual([v('c', 'col!')]);
  expect(c.scopes.globals).toEqual([v('g', 'true')]);
});

test('variables.set goes to runtime', async () => {
  const c = ctx({ environment: [v('x', 'env')] });
  await runScript(`pm.variables.set('x', 'rt'); pm.environment.set('seen', pm.variables.get('x'))`, c);
  expect(c.scopes.runtime).toEqual({ x: 'rt' });
  expect(c.scopes.environment.find((e) => e.key === 'x')!.value).toBe('env');
  expect(c.scopes.environment.find((e) => e.key === 'seen')!.value).toBe('rt');
});

test('pm.test pass/fail', async () => {
  const r = await runScript(`
    pm.test('ok', () => {});
    pm.test('bad', () => { throw new Error('boom'); });
    pm.test('async bad', async () => { await null; throw new Error('later'); });
  `, ctx());
  expect(r.tests).toEqual([
    { name: 'ok', passed: true },
    { name: 'bad', passed: false, error: 'Error: boom' },
    { name: 'async bad', passed: false, error: 'Error: later' },
  ]);
});

test('pm.expect chai', async () => {
  const r = await runScript(`
    pm.test('eq', () => pm.expect({ a: [1, 2] }).to.deep.equal({ a: [1, 2] }));
    pm.test('ne', () => pm.expect(1).to.equal(2));
  `, ctx());
  expect(r.tests[0].passed).toBe(true);
  expect(r.tests[1]).toMatchObject({ passed: false, error: 'AssertionError: expected 1 to equal 2' });
});

test('setNextRequest', async () => {
  expect((await runScript(`pm.setNextRequest('Next')`, ctx())).nextRequest).toBe('Next');
  expect((await runScript(`pm.setNextRequest(null)`, ctx())).nextRequest).toBeNull();
});

test("eval(pm.environment.get('lib')) jsrsasign", async () => {
  const lib = readFileSync('node_modules/jsrsasign/lib/jsrsasign-all-min.js', 'utf8');
  const c = ctx({ environment: [v('lib', lib), v('key', privateKey)] });
  const r = await runScript(`
    eval(pm.environment.get('lib'));
    const jws = KJUR.jws.JWS.sign('RS256', { alg: 'RS256' }, { sub: '1' }, pm.environment.get('key'));
    pm.environment.set('jws', jws);
  `, c);
  expect(r.error).toBeUndefined();
  verifyRs256(c.scopes.environment.find((e) => e.key === 'jws')!.value);
});

test('require jose signs JWS', async () => {
  const c = ctx();
  const r = await runScript(`
    const jose = require('jose');
    const key = await jose.importPKCS8(pm.environment.get('key'), 'RS256');
    const jws = await new jose.CompactSign(new TextEncoder().encode('{"sub":"1"}')).setProtectedHeader({ alg: 'RS256' }).sign(key);
    pm.environment.set('jws', jws);
  `, c);
  expect(r.error).toBeUndefined();
  verifyRs256(c.scopes.environment.find((e) => e.key === 'jws')!.value);
});

test('require jsrsasign RS256 sign', async () => {
  const c = ctx();
  const r = await runScript(`
    const { KJUR, KEYUTIL } = require('jsrsasign');
    const jws = KJUR.jws.JWS.sign('RS256', { alg: 'RS256' }, { sub: '1' }, KEYUTIL.getKey(pm.environment.get('key')));
    pm.environment.set('jws', jws);
  `, c);
  expect(r.error).toBeUndefined();
  verifyRs256(c.scopes.environment.find((e) => e.key === 'jws')!.value);
});

test('crypto-js HMAC', async () => {
  const c = ctx();
  await runScript(`
    pm.environment.set('g', CryptoJS.HmacSHA256('msg', 'secret').toString());
    pm.environment.set('r', require('crypto-js').HmacSHA256('msg', 'secret').toString(require('crypto-js').enc.Hex));
  `, c);
  const expected = 'fe4f9c418f683f034f6af90d1dd5b86ac0355dd96332c59cc74598d0736107f6';
  expect(c.scopes.environment.slice(1).map((e) => e.value)).toEqual([expected, expected]);
});

test('node crypto', async () => {
  const c = ctx();
  await runScript(`pm.environment.set('h', require('crypto').createHash('sha256').update('abc').digest('hex'))`, c);
  expect(c.scopes.environment[1].value).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('unknown API gives readable error', async () => {
  const r = await runScript(`pm.cookies.get('a')`, ctx());
  expect(r.error).toBe('Error: pm.cookies is not supported');
  expect(r.logs).toEqual([{ level: 'error', text: 'Error: pm.cookies is not supported' }]);
  expect((await runScript(`require('fs')`, ctx())).error).toMatch(/require\('fs'\) is not available/);
});

test('sync infinite loop times out', async () => {
  const r = await runScript(`while (true) {}`, ctx());
  expect(r.error).toMatch(/timed out/);
}, 10_000);

test('await never resolving times out', async () => {
  const t = Date.now();
  const r = await runScript(`await new Promise(() => {})`, ctx());
  expect(r.error).toMatch(/timed out/);
  expect(Date.now() - t).toBeGreaterThanOrEqual(4900);
}, 10_000);

test('pm.sendRequest callback and promise', async () => {
  const c = ctx({ environment: [v('base', mock.http)] });
  const r = await runScript(`
    const base = pm.environment.get('base');
    pm.sendRequest(base + '/echo', (err, res) => { pm.environment.set('cb', res.json().method); });
    const res = await pm.sendRequest({ url: base + '/echo', method: 'post', header: [{ key: 'X-A', value: '1' }],
      body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: 'b c' }] } });
    pm.environment.set('promise', res.json().body + ' ' + res.json().headers['x-a'] + ' ' + res.code);
    setTimeout(() => pm.environment.set('timer', 'fired'), 50);
    pm.sendRequest('http://127.0.0.1:1/', (err) => pm.environment.set('err', err.code));
  `, c);
  expect(r.error).toBeUndefined();
  const env = Object.fromEntries(c.scopes.environment.map((e) => [e.key, e.value]));
  expect(env).toMatchObject({ cb: 'GET', promise: 'a=b+c 1 200', timer: 'fired', err: 'ECONNREFUSED' });
});

test('console.log captured', async () => {
  const r = await runScript(`console.log('a', 1, { b: 2 }); console.warn('w')`, ctx());
  expect(r.logs).toEqual([{ level: 'log', text: 'a 1 { b: 2 }' }, { level: 'warn', text: 'w' }]);
});

test('global assigned in one run is not visible in the next', async () => {
  const first = await runScript(`leakedToken = 'abc'; await null; pm.environment.set('seen', typeof leakedToken)`, ctx());
  expect(first.error).toBeUndefined();
  const c = ctx();
  const second = await runScript(`pm.environment.set('seen', typeof leakedToken)`, c);
  expect(second.error).toBeUndefined();
  expect(c.scopes.environment.find((e) => e.key === 'seen')!.value).toBe('undefined');
});

test('interval and immediate are tracked and cleared after the run', async () => {
  const c = ctx();
  const r = await runScript(`
    let n = 0;
    const id = setInterval(() => { if (++n === 3) { clearInterval(id); pm.environment.set('n', n); } }, 5);
    setImmediate(() => pm.environment.set('imm', 'yes'));
  `, c);
  expect(r.error).toBeUndefined();
  expect(Object.fromEntries(c.scopes.environment.map((e) => [e.key, e.value]))).toMatchObject({ n: '3', imm: 'yes' });

  // a forgotten interval times the script out and is cleared, it does not keep ticking
  const t = await runScript(`setInterval(() => console.log('tick'), 1000)`, ctx());
  expect(t.error).toMatch(/timed out/);
  const logged = t.logs.length;
  await new Promise((res) => setTimeout(res, 1100));
  expect(t.logs.length).toBe(logged);
}, 10_000);

test('timer started after the script timed out is never created', async () => {
  // globalThis.setTimeout is the real, untracked timer: it outlives the script timeout
  const r = await runScript(`
    await new Promise((res) => globalThis.setTimeout(res, 5300));
    setInterval(() => console.log('late tick'), 10);
  `, ctx());
  expect(r.error).toMatch(/timed out/);
  await new Promise((res) => setTimeout(res, 600));
  expect(r.logs.some((l) => JSON.stringify(l).includes('late tick'))).toBe(false);
}, 10_000);
