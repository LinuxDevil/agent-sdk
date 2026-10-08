import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Eve DUI-F1: `lousho studio --dev` prints http://localhost:5173/?token=...
    // and tells the API server to accept this origin, so the port is fixed.
    port: 5173,
    strictPort: true,
    // LOU-N: proxy the runtime control server's REST + WS API (default
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
      // LOU-D45: time-travel routes (history, fork, compare).
      '/runs': { target: process.env.LOUSHO_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // jsdom throws for `window.localStorage` on an opaque (about:blank)
    // origin, which is the environment's default when no url is given -
    // LocalStorageAgentStore's tests need a real http(s) origin.
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
