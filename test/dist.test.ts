import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startMockServer } from './mockServer';

let server: ChildProcess;
let baseUrl: string;
let mock: Awaited<ReturnType<typeof startMockServer>>;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cirt-dist-'));
const dataDir = path.join(tmp, 'data');

beforeAll(async () => {
  mock = await startMockServer();
  // run a copy outside the project so no node_modules is reachable, as on the user's machine
  cpSync('dist', path.join(tmp, 'dist'), { recursive: true });
  server = spawn(process.execPath, [path.join('dist', 'server.cjs')], {
    cwd: tmp,
    env: { ...process.env, PORT: '0', HOST: 'localhost', DATA_DIR: dataDir, NODE_PATH: '' },
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (chunk) => {
      out += chunk;
      const m = out.match(/http:\/\/\S+/);
      if (m) resolve(m[0]);
    });
    server.stderr!.on('data', (chunk) => { out += chunk; });
    server.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
});

afterAll(async () => {
  server?.kill();
  await mock?.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('dist serves health and index', async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  for (const p of ['/', '/some/client/route']) {
    const page = await fetch(baseUrl + p);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
  }
});

test('dist smoke: run with jsrsasign+jose', async () => {
  const pre = [
    "const { KJUR } = require('jsrsasign');",
    "const jose = require('jose');",
    "const jws = KJUR.jws.JWS.sign('HS256', JSON.stringify({ alg: 'HS256' }), JSON.stringify({ sub: 'rs' }), { utf8: 'secret' });",
    "pm.request.headers.upsert({ key: 'X-Jws', value: jws });",
    "pm.variables.set('jwt', await new jose.SignJWT({ sub: 'jose' }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('secret')));",
  ];
  const testScript = [
    "const jose = require('jose');",
    "const { headers } = pm.response.json();",
    "pm.test('status', () => pm.response.to.have.status(200));",
    "pm.test('jsrsasign JWS sent', () => pm.expect(require('jsrsasign').KJUR.jws.JWS.verify(headers['x-jws'], { utf8: 'secret' }, ['HS256'])).to.be.true);",
    "const { payload } = await jose.jwtVerify(headers.authorization.slice(7), new TextEncoder().encode('secret'));",
    "pm.test('jose JWT sent', () => pm.expect(payload.sub).to.equal('jose'));",
  ];
  const collection = {
    info: { _postman_id: 'dist-smoke', name: 'Dist smoke', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'base', value: mock.http }],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{jwt}}' }] },
    item: [{
      name: 'Signed echo',
      event: [{ listen: 'prerequest', script: { exec: pre } }, { listen: 'test', script: { exec: testScript } }],
      request: { method: 'GET', url: '{{base}}/echo' },
    }],
  };
  const post = (url: string, body: unknown) =>
    fetch(baseUrl + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const imported = await post('/api/import', collection);
  expect(imported.status).toBe(200);
  const { id } = await imported.json();
  const col = await (await fetch(`${baseUrl}/api/collections/${id}`)).json();

  const res = await post('/api/run', { collectionId: id, requestId: col.items[0].id });
  expect(res.status).toBe(200);
  const run = await res.json();
  expect(run.preScripts[0].error).toBeUndefined();
  expect(run.testScripts[0].error).toBeUndefined();
  expect(run.testScripts[0].tests).toEqual([
    { name: 'status', passed: true },
    { name: 'jsrsasign JWS sent', passed: true },
    { name: 'jose JWT sent', passed: true },
  ]);
});
