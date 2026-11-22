/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/public', emptyOutDir: true },
  server: {
    proxy: {
      // changeOrigin: the server's Host guard only accepts localhost:3000
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      // changeOrigin rewrites only Host; /ws also requires Origin to match it
      '/ws': { target: 'ws://localhost:3000', ws: true, changeOrigin: true, configure: (proxy) => proxy.on('proxyReqWs', (r) => r.setHeader('origin', 'http://localhost:3000')) },
    },
  },
  test: { root: '.', environment: 'node' },
});
