import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from './studio';

describe('startStudio', () => {
  it('throws a clear error when apps/agent-forge is not found under repoRoot', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-studio-test-'));
    expect(() => startStudio({ repoRoot })).toThrow(/could not find apps\/agent-forge/);
  });

  // Actually spawning the API server + Vite dev server child processes
  // (npm run server:dev / npm run dev in apps/agent-forge) is exercised
  // manually/in the real monorepo rather than here: it needs a full
  // `npm install` in apps/agent-forge and binds real ports, which would
  // make this suite slow and environment-dependent. The LOU-N server's own
  // behavior (routes, run/stop/approve semantics) is covered directly by
  // apps/agent-forge/server/__tests__/*.test.ts instead - this file only
  // covers startStudio()'s own pure logic (the apps/agent-forge lookup).
});
