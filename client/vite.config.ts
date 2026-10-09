import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  publicDir: path.resolve(__dirname, '../public'),
  server: {
    port: 5173,
    host: true,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  preview: { port: 4173, host: true, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
});
