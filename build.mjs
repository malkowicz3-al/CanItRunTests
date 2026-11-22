import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { server: 'server/main.ts', worker: 'server/worker.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22.0',
  outExtension: { '.js': '.cjs' },
  // optional native add-ons of ws, loaded inside try/catch
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  spawn(process.execPath, ['--watch', 'dist/server.cjs'], { stdio: 'inherit' });
} else {
  await esbuild.build(options);
}
