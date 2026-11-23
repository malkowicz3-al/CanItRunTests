import http from 'node:http';
import https from 'node:https';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startMockServer } from '../../test/mockServer';
import { execute, type HttpOptions } from './http';

let mock: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => { mock = await startMockServer(); });
afterAll(() => mock.close());

const opts: HttpOptions = { ignoreTls: false, timeoutMs: 5000 };
const get = (url: string, o: Partial<HttpOptions> = {}) => execute({ method: 'GET', url, headers: {} }, { ...opts, ...o });
const post = (url: string, headers: Record<string, string> = {}, o: Partial<HttpOptions> = {}) =>
  execute({ method: 'POST', url, headers: { 'content-type': 'text/plain', ...headers }, body: 'payload' }, { ...opts, ...o });
const echo = (r: Awaited<ReturnType<typeof execute>>) => JSON.parse(r.response!.body);

test('timings populated', async () => {
  const r = await get(`${mock.https}/echo`, { ignoreTls: true });
  const t = r.response!.timings;
  expect(r.response!.status).toBe(200);
  expect(t.tcp).toBeGreaterThan(0);
  expect(t.tls).toBeGreaterThan(0);
  expect(t.ttfb).toBeGreaterThan(0);
  expect(t.transfer).toBeGreaterThanOrEqual(0);
  expect(t.total).toBeGreaterThanOrEqual(t.tcp + t.tls + t.ttfb);
  expect(r.response!.size).toBeGreaterThan(0);
});

test('gzip/br decoded', async () => {
  for (const p of ['gzip', 'br', 'deflate']) {
    const r = await post(`${mock.http}/${p}`);
    expect(echo(r).body).toBe('payload');
  }
});

test('HEAD with gzip encoding and no body returns 200', async () => {
  const r = await execute({ method: 'HEAD', url: `${mock.http}/gzip`, headers: {} }, opts);
  expect(r.error).toBeUndefined();
  expect(r.response).toMatchObject({ status: 200, body: '' });
});

test('body over 10 MB truncated', async () => {
  const r = await get(`${mock.http}/big`);
  expect(r.response!.truncated).toBe(true);
  expect(r.response!.body.length).toBe(10 * 1024 * 1024);
  expect(r.response!.size).toBe(11 * 1024 * 1024);
});

test('ECONNREFUSED code', async () => {
  const r = await get('http://127.0.0.1:1/');
  expect(r.error?.code).toBe('ECONNREFUSED');
});

test('ETIMEDOUT', async () => {
  const r = await get(`${mock.http}/slow?ms=2000`, { timeoutMs: 200 });
  expect(r.error?.code).toBe('ETIMEDOUT');
});

test('self-signed rejected + ignoreTls passes', async () => {
  const bad = await get(`${mock.https}/echo`);
  expect(bad.error?.code).toMatch(/CERT|SIGNATURE/);
  const ok = await get(`${mock.https}/echo`, { ignoreTls: true });
  expect(ok.response?.status).toBe(200);
});

test('mTLS required cert', async () => {
  const ca = mock.certs.ca;
  const without = await get(`${mock.mtls}/echo`, { clientCert: { cert: '', key: '', ca } });
  expect(without.error).toBeDefined();
  const withCert = await get(`${mock.mtls}/echo`, { clientCert: { ...mock.certs.client, ca } });
  expect(withCert.response?.status).toBe(200);
});

test('follows 302 by default', async () => {
  const r = await get(`${mock.http}/redirect?status=302&to=/echo`);
  expect(r.response?.status).toBe(200);
  expect(r.redirects).toEqual([{ status: 302, method: 'GET', url: `${mock.http}/redirect?status=302&to=/echo` }]);
  expect(r.finalRequest.url).toBe(`${mock.http}/echo`);
});

test('303 POST->GET', async () => {
  const r = await post(`${mock.http}/redirect?status=303`);
  expect(echo(r)).toMatchObject({ method: 'GET', body: '' });
  expect(echo(r).headers['content-type']).toBeUndefined();
  expect(r.finalRequest).toMatchObject({ method: 'GET', body: undefined });
});

test('307 keeps body', async () => {
  const r = await post(`${mock.http}/redirect?status=307`);
  expect(echo(r)).toMatchObject({ method: 'POST', body: 'payload' });
});

test('followRedirects=false returns 3xx', async () => {
  const r = await get(`${mock.http}/redirect?status=301`, { followRedirects: false });
  expect(r.response?.status).toBe(301);
  expect(r.redirects).toEqual([]);
});

test('redirect loop limit', async () => {
  const r = await get(`${mock.http}/loop`);
  expect(r.error?.code).toBe('ERR_TOO_MANY_REDIRECTS');
  expect(r.redirects).toHaveLength(11);
});

test('auth header stripped cross-host', async () => {
  const headers = { Authorization: 'Bearer x', Cookie: 'a=1', 'X-Keep': 'y' };
  const same = await post(`${mock.http}/redirect?status=307&to=/echo`, headers);
  expect(echo(same).headers).toMatchObject({ authorization: 'Bearer x', cookie: 'a=1' });
  const to = encodeURIComponent(`http://localhost:${mock.httpPort}/echo`);
  const cross = await post(`${mock.http}/redirect?status=307&to=${to}`, headers);
  const h = echo(cross).headers;
  expect(h.authorization).toBeUndefined();
  expect(h.cookie).toBeUndefined();
  expect(h['x-keep']).toBe('y');
});

test('keep-alive agents reuse the socket for http and https', async () => {
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  try {
    for (const base of [mock.http, mock.https]) {
      const first = await get(`${base}/echo`, { agents, ignoreTls: true });
      const second = await get(`${base}/echo`, { agents, ignoreTls: true });
      expect(first.response!.timings.tcp).toBeGreaterThan(0);
      expect(second.response!.status).toBe(200);
      expect(second.response!.timings).toMatchObject({ dns: 0, tcp: 0, tls: 0 });
    }
  } finally {
    agents.http.destroy();
    agents.https.destroy();
  }
});
