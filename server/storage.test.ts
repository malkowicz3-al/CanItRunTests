import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cirt-storage-'));
let storage: typeof import('./storage');

beforeAll(async () => {
  process.env.DATA_DIR = dataDir; // config reads it at import time
  storage = await import('./storage');
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test('atomic write', async () => {
  await storage.writeJson('collections/a.json', { v: 0 });
  const big = { v: 1, pad: 'x'.repeat(2_000_000) };
  const write = storage.writeJson('collections/a.json', big);
  // a reader during the write sees either the old or the new file, never a partial one
  const seen = await Promise.all(Array.from({ length: 20 }, () => storage.readJson<{ v: number }>('collections/a.json')));
  await write;
  for (const s of seen) expect([0, 1]).toContain(s!.v);
  expect((await storage.readJson<{ v: number }>('collections/a.json'))!.v).toBe(1);
  expect(readdirSync(path.join(dataDir, 'collections'))).toEqual(['a.json']);
});

test('serializes concurrent writes', async () => {
  await Promise.all(Array.from({ length: 30 }, (_, i) => storage.writeJson('globals.json', { i })));
  expect(await storage.readJson('globals.json')).toEqual({ i: 29 });
  expect(readdirSync(dataDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

test('rejects path traversal id', async () => {
  for (const rel of ['collections/../../x.json', '../x.json', 'collections/a\\..\\b.json', '/etc/passwd', 'C:/x.json']) {
    await expect(storage.readJson(rel)).rejects.toThrow(/Invalid path/);
    expect(() => storage.writeJson(rel, {})).toThrow(/Invalid path/);
  }
});

test('list skips tmp files', async () => {
  const dir = path.join(dataDir, 'environments');
  mkdirSync(dir, { recursive: true });
  await storage.writeJson('environments/e1.json', { id: 'e1' });
  writeFileSync(path.join(dir, 'e2.json.123.tmp'), '{"id":"partial');
  expect(await storage.list('environments')).toEqual([{ id: 'e1' }]);
  expect(await storage.list('missing')).toEqual([]);
  await storage.remove('environments/e1.json');
  expect(await storage.readJson('environments/e1.json')).toBeUndefined();
});

test('list skips corrupt file', async () => {
  await storage.writeJson('corrupt/ok.json', { id: 'ok' });
  writeFileSync(path.join(dataDir, 'corrupt', 'bad.json'), '{"id":');
  expect(await storage.list('corrupt')).toEqual([{ id: 'ok' }]);
  expect(readdirSync(path.join(dataDir, 'corrupt')).sort()).toEqual(['bad.json', 'ok.json']); // not deleted
  await expect(storage.readJson('corrupt/bad.json')).rejects.toThrow(/corrupt\/bad\.json is not valid JSON/);
});

test('updateJson read-modify-write is serialized', async () => {
  await storage.writeJson('counter.json', { n: 0 });
  await Promise.all(Array.from({ length: 20 }, () => storage.updateJson<{ n: number }>('counter.json', (c) => ({ n: c!.n + 1 }))));
  expect(await storage.readJson('counter.json')).toEqual({ n: 20 });
  await storage.updateJson('gone.json', (c) => c); // undefined: nothing written
  expect(await storage.readJson('gone.json')).toBeUndefined();
});
