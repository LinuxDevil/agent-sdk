import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

/** The lousho SDK version (root package.json), shown as the nav's version tag (src/shell/version.d.ts). */
const LOUSHO_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __LOUSHO_VERSION__: JSON.stringify(LOUSHO_VERSION) },
  server: {
    // `lousho studio --dev` prints http://localhost:5173/?token=...
    // and tells the API server to accept this origin, so the port is fixed.
    port: 5173,
    strictPort: true,
    // Proxy the runtime control server's REST + WS API (default
    // http://127.0.0.1:4750, see apps/agent-forge/server/index.ts and
    // `lousho studio`'s PORT env var) through Vite's own dev server, so the
    // browser app can call it same-origin (RuntimeClient defaults to a
    // relative baseUrl) instead of hardcoding a second port/CORS setup.
    proxy: {
      '/agents': {
        target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750',
        changeOrigin: true,
        ws: true,
      },
      // Time-travel routes (history, fork, compare).
      '/runs': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
      // The observe panels' read path - proxied through the studio API
      // server (same as prod; it forwards to the `lousho observe` daemon,
      // which serves no CORS headers of its own).
      '/observe': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
      // The playground's SSE run endpoint.
      '/playground': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
      // Settings routes (provider keys, profiles, deploy adapters, named secrets).
      '/settings': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
      // The SDK catalogs + registry index (models, tools, guardrails, triggers, skills, kits).
      '/catalog': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
      // The workspace registry routes (GET/POST /workspaces, DELETE /workspaces/:ws).
      '/workspaces': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
      // The Agent Author's session routes (and its WS stream once it lands under the same prefix).
      '/assistant': {
        target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // jsdom throws for `window.localStorage`/`sessionStorage` on an opaque
    // (about:blank) origin, which is the environment's default when no url
    // is given - the studio token and draft cache need a real http(s) origin.
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
