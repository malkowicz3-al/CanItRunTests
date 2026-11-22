import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WsMessage } from '../shared/api';
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

test('dist smoke: flow run over /ws', async () => {
  const post = (url: string, body: unknown) =>
    fetch(baseUrl + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const collection = {
    info: { _postman_id: 'dist-flow', name: 'Dist flow', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'base', value: mock.http }],
    item: [
      { name: 'A', event: [{ listen: 'test', script: { exec: ["pm.collectionVariables.set('token', 'from-a')"] } }], request: { method: 'GET', url: '{{base}}/echo' } },
      { name: 'B', event: [{ listen: 'test', script: { exec: ["pm.test('token passed', () => pm.expect(pm.response.json().headers['x-token']).to.equal('from-a'))"] } }],
        request: { method: 'GET', url: '{{base}}/echo', header: [{ key: 'X-Token', value: '{{token}}' }] } },
    ],
  };
  const { id: collectionId } = await (await post('/api/import', collection)).json();
  const col = await (await fetch(`${baseUrl}/api/collections/${collectionId}`)).json();
  const node = (id: string, requestId: string) => ({ id, type: 'request', position: { x: 0, y: 0 }, data: { collectionId, requestId, continueWhen: [] } });
  const flow = await (await post('/api/flows', {
    name: 'Dist flow',
    nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }, node('a', col.items[0].id), node('b', col.items[1].id)],
    edges: [{ id: 'e1', source: 'start', sourceHandle: 'ok', target: 'a' }, { id: 'e2', source: 'a', sourceHandle: 'ok', target: 'b' }],
  })).json();

  const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/ws');
  const messages: WsMessage[] = [];
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const done = new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      messages.push(JSON.parse(String(e.data)));
      if (messages.at(-1)!.type === 'flow.done') resolve();
    };
  });
  const run = await post(`/api/flows/${flow.id}/run`, {});
  expect(run.status).toBe(200);
  await done;
  ws.close();

  expect(messages.at(-1)).toMatchObject({ type: 'flow.done', status: 'done' });
  const b = messages.find((m) => m.type === 'flow.node' && m.phase === 'end' && m.nodeId === 'b');
  expect(b).toMatchObject({ outcome: 'ok' });
  expect(b?.type === 'flow.node' && b.phase === 'end' && b.result.testScripts[0].tests).toEqual([{ name: 'token passed', passed: true }]);
});

test('dist /ws closes a connection from a foreign Origin', async () => {
  const { hostname, port } = new URL(baseUrl);
  const req = http.request({ hostname, port, path: '/ws', headers: {
    connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), origin: 'http://evil.example',
  } });
  const frame = await new Promise<Buffer>((resolve, reject) => {
    req.on('upgrade', (_res, socket, head) => {
      socket.on('error', () => {}); // the server drops the socket after the close frame
      if (head.length) return resolve(head);
      socket.once('data', resolve);
    });
    req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
  req.destroy();
  expect(frame[0]).toBe(0x88); // FIN + close opcode
  expect(frame.readUInt16BE(2)).toBe(1008);
});
