import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

/** Bundles server/worker.ts like build.mjs does, so worker tests do not depend on a prior `npm run build`. */
export async function buildWorker(): Promise<string> {
  const outfile = path.join(mkdtempSync(path.join(os.tmpdir(), 'cirt-worker-')), 'worker.cjs');
  await esbuild.build({ entryPoints: ['server/worker.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22.0', logLevel: 'warning' });
  return outfile;
}
