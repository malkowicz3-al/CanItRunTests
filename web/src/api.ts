import type { ImportResult, RunRequestBody, RunResult } from '../../shared/api';
import type { Collection, Environment, Globals, Id } from '../../shared/model';

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // no Content-Type without a body: Fastify rejects an empty JSON body
  const res = await fetch(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const err = data as { message?: string; error?: string } | undefined;
    const msg = err?.message ?? err?.error ?? res.statusText;
    throw new ApiError(res.status, data, `${res.status}: ${msg}`);
  }
  return data as T;
}

export const api = {
  listCollections: () => call<{ id: Id; name: string }[]>('GET', '/api/collections'),
  getCollection: (id: Id) => call<Collection>('GET', `/api/collections/${id}`),
  saveCollection: (c: Collection) => call<Collection>('PUT', `/api/collections/${c.id}`, c),
  deleteCollection: (id: Id) => call<void>('DELETE', `/api/collections/${id}`),
  listEnvironments: () => call<Environment[]>('GET', '/api/environments'),
  createEnvironment: (e: Partial<Environment>) => call<Environment>('POST', '/api/environments', e),
  saveEnvironment: (e: Environment) => call<Environment>('PUT', `/api/environments/${e.id}`, e),
  deleteEnvironment: (id: Id) => call<void>('DELETE', `/api/environments/${id}`),
  getGlobals: () => call<Globals>('GET', '/api/globals'),
  saveGlobals: (g: Globals) => call<Globals>('PUT', '/api/globals', g),
  importPostman: (json: unknown, overwrite: boolean) => call<ImportResult>('POST', `/api/import${overwrite ? '?overwrite=true' : ''}`, json),
  run: (b: RunRequestBody) => call<RunResult>('POST', '/api/run', b),
};
