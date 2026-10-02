/**
 * Test helper: runs bundle builds one at a time across vitest workers.
 *
 * On Windows with Node 26, two parallel vitest workers that each bundle the SDK
 * with tsup/esbuild (the `src/deploy/**` tests do) intermittently kill the
 * vitest process with a native crash (exit codes 3221225477 / 3221226356 /
 * 3221226505, shown as 127 or 139 by Git Bash/npx) right after the `RUN` banner,
 * and no test output. Builds that do not overlap never crash, so the files that
 * build take this lock around the build.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.join(os.tmpdir(), 'lousho-bundle-build.lock');
const STALE_MS = 3 * 60_000;
const POLL_MS = 50;

function tryAcquire(): boolean {
  try {
    fs.mkdirSync(LOCK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = fs.statSync(LOCK, { throwIfNoEntry: false });
    if (stat && Date.now() - stat.mtimeMs > STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true });
    return false;
  }
}

/** Runs `build` while holding a machine-wide lock, so no two bundle builds overlap. */
export async function withBuildLock<T>(build: () => Promise<T>): Promise<T> {
  while (!tryAcquire()) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  try {
    return await build();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}
