import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // LOU-N: proxy the runtime control server's REST + WS API (default
    // http://127.0.0.1:4750, see apps/agent-forge/server/index.ts and
    // `loushy studio`'s PORT env var) through Vite's own dev server, so the
    // browser app can call it same-origin (RuntimeClient defaults to a
    // relative baseUrl) instead of hardcoding a second port/CORS setup.
    proxy: {
      '/agents': {
        target: process.env.LOUSHY_STUDIO_API_URL ?? 'http://127.0.0.1:4750',
        changeOrigin: true,
        ws: true,
      },
      // LOU-D45: time-travel routes (history, fork, compare).
      '/runs': { target: process.env.LOUSHY_STUDIO_API_URL ?? 'http://127.0.0.1:4750', changeOrigin: true },
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
