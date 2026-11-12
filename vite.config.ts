import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
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
  build: { chunkSizeWarningLimit: 2000 },
});
