import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
// @ts-ignore - plain ESM module without type declarations
import { createApiHandler } from './server/api.mjs';

/** Runs the database API inside the Vite dev / preview server, so `npm run dev` starts everything. */
function reportToolApi(): Plugin {
  return {
    name: 'reporttool-api',
    configureServer(server) {
      server.middlewares.use(createApiHandler());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiHandler());
    },
  };
}

export default defineConfig({
  plugins: [vue(), reportToolApi()],
  base: './',
  server: { port: 5173, open: false, host: 'localhost' },
  build: {
    chunkSizeWarningLimit: 2000,
    // two pages: the designer (index.html) and the Report Viewer (viewer.html)
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      },
    },
  },
});
