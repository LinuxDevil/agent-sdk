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

  it("--prod throws a clear, build-pointing error when apps/agent-forge/dist-server is missing", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-studio-test-'));
    fs.mkdirSync(path.join(repoRoot, 'apps', 'agent-forge'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'apps', 'agent-forge', 'package.json'), '{}');
    expect(() => startStudio({ repoRoot, mode: 'prod' })).toThrow(/build:studio/);
  });

  it("--dev throws a clear error when apps/agent-forge/server source is missing", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-studio-test-'));
    fs.mkdirSync(path.join(repoRoot, 'apps', 'agent-forge'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'apps', 'agent-forge', 'package.json'), '{}');
    expect(() => startStudio({ repoRoot, mode: 'dev' })).toThrow(/dev mode/);
  });

  it("mode: 'auto' resolves to prod when apps/agent-forge/dist-server/index.cjs has been built", () => {
    // Exercised indirectly: 'auto' with a built dist-server/index.cjs present
    // should hit the *prod* code path, which spawns `node <entry>` - proven
    // here by asserting it does NOT throw the dev-mode-only source error,
    // and instead returns a handle with mode: 'prod' (no viteProcess).
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-studio-test-'));
    const appDir = path.join(repoRoot, 'apps', 'agent-forge');
    fs.mkdirSync(path.join(appDir, 'dist-server'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), '{}');
    // A trivial entry that exits immediately so the child process doesn't
    // linger past the test.
    fs.writeFileSync(path.join(appDir, 'dist-server', 'index.cjs'), 'process.exit(0);');

    const handle = startStudio({ repoRoot, apiPort: 0 });
    try {
      expect(handle.mode).toBe('prod');
      expect(handle.viteProcess).toBeUndefined();
    } finally {
      handle.stop();
    }
  });

  // Actually spawning the real API server + Vite dev server child processes
  // (npm run server:dev / npm run dev in apps/agent-forge) is exercised
  // manually/in the real monorepo rather than here: it needs a full
  // `npm install` in apps/agent-forge and binds real ports, which would
  // make this suite slow and environment-dependent. The LOU-N server's own
  // behavior (routes, run/stop/approve semantics) is covered directly by
  // apps/agent-forge/server/__tests__/*.test.ts instead - this file only
  // covers startStudio()'s own pure logic (the apps/agent-forge lookup and
  // dev/prod/auto mode resolution).
});
