import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
