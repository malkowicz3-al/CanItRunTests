import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { ImportConflict, ImportResult, RunRequestBody, RunResult } from '../shared/api';
import type { Collection, Environment, Globals, Id } from '../shared/model';
import { HOST } from './config';
import { importPostman, keepItemIds } from './importers/postman';
import type { RunPool } from './runPool';
import { applyDiff, type ScopeDiff } from './core/run';
import { list, readJson, remove, updateJson, writeJson } from './storage';

export const badRequest = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
export const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { statusCode: 404 });
export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export function objBody(x: unknown): Record<string, unknown> {
  if (!isObj(x)) throw badRequest('Expected a JSON object body');
  return x;
}

export type IdParams = { Params: { id: string } };

export function registerRoutes(app: FastifyInstance, pool: RunPool): void {
  // Only JSON bodies: blocks simple cross-site form posts (CSRF).
  app.removeContentTypeParser('text/plain');

  if (HOST === 'localhost' || HOST === '127.0.0.1') {
    // DNS rebinding guard: a foreign page resolving its own name to 127.0.0.1 sends a foreign Host.
    app.addHook('onRequest', async (req, reply) => {
      const port = (app.server.address() as AddressInfo | null)?.port;
      const allowed = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
      if (!allowed.includes(req.headers.host ?? '')) return reply.code(403).send({ error: 'Forbidden host' });
    });
  }

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/collections', async () => (await list<Collection>('collections')).map(({ id, name }) => ({ id, name })));
  app.get<IdParams>('/api/collections/:id', async (req) => (await readJson<Collection>(`collections/${req.params.id}.json`)) ?? Promise.reject(notFound('Collection')));
  app.put<IdParams>('/api/collections/:id', async (req) => {
    const c = { ...objBody(req.body), id: req.params.id } as unknown as Collection;
    await writeJson(`collections/${c.id}.json`, c);
    return c;
  });
  app.delete<IdParams>('/api/collections/:id', async (req, reply) => { await remove(`collections/${req.params.id}.json`); return reply.code(204).send(); });

  app.get('/api/environments', async () => list<Environment>('environments'));
  app.post('/api/environments', async (req) => {
    const e: Environment = { name: 'New environment', values: [], ignoreTls: false, followRedirects: true, ...objBody(req.body ?? {}), id: randomUUID() };
    await writeJson(`environments/${e.id}.json`, e);
    return e;
  });
  app.get<IdParams>('/api/environments/:id', async (req) => (await readJson<Environment>(`environments/${req.params.id}.json`)) ?? Promise.reject(notFound('Environment')));
  app.put<IdParams>('/api/environments/:id', async (req) => {
    const e = { ...objBody(req.body), id: req.params.id } as unknown as Environment;
    await writeJson(`environments/${e.id}.json`, e);
    return e;
  });
  app.delete<IdParams>('/api/environments/:id', async (req, reply) => { await remove(`environments/${req.params.id}.json`); return reply.code(204).send(); });

  app.get('/api/globals', async (): Promise<Globals> => (await readJson<Globals>('globals.json')) ?? { values: [] });
  app.put('/api/globals', async (req) => {
    const g = objBody(req.body);
    if (!Array.isArray(g.values)) throw badRequest('globals.values must be an array');
    await writeJson('globals.json', { values: g.values });
    return { values: g.values };
  });

  app.post<{ Querystring: { overwrite?: string } }>('/api/import', async (req, reply): Promise<ImportResult | ImportConflict> => {
    const imp = importPostman(req.body);
    if (imp.kind === 'globals') {
      const current = await readJson<Globals>('globals.json');
      if (current?.values.length && req.query.overwrite !== 'true') return reply.code(409).send({ existingId: 'globals', name: 'Globals' } satisfies ImportConflict);
      await writeJson('globals.json', imp.globals);
      return { kind: 'globals', warnings: imp.warnings };
    }
    const dir = imp.kind === 'collection' ? 'collections' : 'environments';
    const doc = imp.kind === 'collection' ? imp.collection : imp.environment;
    const existing = doc.sourceId === undefined ? undefined : (await list<Collection | Environment>(dir)).find((x) => x.sourceId === doc.sourceId);
    if (existing) {
      if (req.query.overwrite !== 'true') return reply.code(409).send({ existingId: existing.id, name: existing.name } satisfies ImportConflict);
      doc.id = existing.id;
      if (imp.kind === 'collection') imp.collection.items = keepItemIds((existing as Collection).items, imp.collection.items);
    }
    await writeJson(`${dir}/${doc.id}.json`, doc);
    return { kind: imp.kind, id: doc.id, name: doc.name, warnings: imp.warnings };
  });

  app.post('/api/run', async (req): Promise<RunResult> => {
    const b = objBody(req.body) as Partial<RunRequestBody>;
    if (typeof b.collectionId !== 'string' || typeof b.requestId !== 'string') throw badRequest('collectionId and requestId are required');
    if (b.environmentId !== undefined && typeof b.environmentId !== 'string') throw badRequest('environmentId must be a string');
    if (b.request !== undefined && (!isObj(b.request) || b.request.kind !== 'request')) throw badRequest('request must be a request item');
    const collection = await readJson<Collection>(`collections/${b.collectionId}.json`);
    if (!collection) throw notFound('Collection');
    const env = b.environmentId === undefined ? undefined : await readJson<Environment>(`environments/${b.environmentId}.json`);
    if (b.environmentId !== undefined && !env) throw notFound('Environment');
    const globals = (await readJson<Globals>('globals.json')) ?? { values: [] };

    const { result, diff } = await pool.run({
      collection, requestId: b.requestId, override: b.request, env,
      scopes: { runtime: {}, environment: env?.values ?? [], collection: collection.variables, globals: globals.values },
    });

    await persistDiff(diff, env?.id, collection.id);
    return result;
  });
}

/** Applies only the keys a run changed to the fresh files, so edits saved during the run and parallel runs are kept (a deleted file stays deleted). */
export async function persistDiff(diff: ScopeDiff, envId: Id | undefined, collectionId: Id): Promise<void> {
  const { environment: de, collection: dc, globals: dg } = diff;
  if (de && envId) await updateJson<Environment>(`environments/${envId}.json`, (f) => f && { ...f, values: applyDiff(f.values, de) });
  if (dc) await updateJson<Collection>(`collections/${collectionId}.json`, (f) => f && { ...f, variables: applyDiff(f.variables, dc) });
  if (dg) await updateJson<Globals>('globals.json', (f) => ({ values: applyDiff(f?.values ?? [], dg) }));
}
