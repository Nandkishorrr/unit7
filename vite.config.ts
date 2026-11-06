import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: fileURLToPath(new URL('web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: Number(process.env.WEB_PORT ?? 4801), proxy: { '/api': { target: process.env.UNIT7_API ?? 'http://127.0.0.1:4800', changeOrigin: false, ws: true } } },
});
