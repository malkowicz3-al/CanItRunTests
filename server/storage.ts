import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';

// Each segment is an id-like name (regex from ARCHITECTURE §5), optional .json at the end: blocks '..', absolute paths, backslashes.
const SAFE_REL = /^[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)*(\.json)?$/;
const queues = new Map<string, Promise<unknown>>();

function resolvePath(rel: string): string {
  if (!SAFE_REL.test(rel)) throw Object.assign(new Error(`Invalid path: ${rel}`), { statusCode: 400 });
  return path.join(DATA_DIR, ...rel.split('/'));
}

function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(task);
  queues.set(file, next);
  next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
  return next;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows: antivirus/indexer briefly holds the target open.
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export async function readJson<T>(rel: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(resolvePath(rel), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw Object.assign(new Error(`Data file ${rel} is not valid JSON (${(err as Error).message}); fix or delete it`), { code: 'EBADJSON', statusCode: 500 });
  }
}

async function write(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export function writeJson(rel: string, data: unknown): Promise<void> {
  const file = resolvePath(rel);
  return enqueue(file, () => write(file, data));
}

/** Read-modify-write inside the file's queue; `fn` returning undefined skips the write (e.g. the file was deleted). */
export function updateJson<T>(rel: string, fn: (current: T | undefined) => T | undefined): Promise<void> {
  const file = resolvePath(rel);
  return enqueue(file, async () => {
    const next = fn(await readJson<T>(rel));
    if (next !== undefined) await write(file, next);
  });
}

export async function list<T>(dir: string): Promise<T[]> {
  const full = resolvePath(dir);
  let names: string[];
  try {
    names = await fs.readdir(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // readJson: a file removed after readdir yields undefined instead of failing the whole list.
  // A corrupt file is skipped (not deleted) so one bad file does not break the whole GUI.
  const items = await Promise.all(names.filter((n) => /^[A-Za-z0-9-]+\.json$/.test(n)).map((n) => readJson<T>(`${dir}/${n}`).catch((err) => {
    if (err.code !== 'EBADJSON') throw err;
    console.warn(err.message);
    return undefined;
  })));
  return items.filter((x) => x !== undefined) as T[];
}

export function remove(rel: string): Promise<void> {
  const file = resolvePath(rel);
  return enqueue(file, () => fs.rm(file, { force: true }));
}
