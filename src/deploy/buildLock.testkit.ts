/**
 * Test helper: runs bundle builds one at a time across vitest workers.
 *
 * On Windows with Node 26, two parallel vitest workers that each bundle the SDK
 * with tsup/esbuild (the `src/deploy/**` tests do) intermittently kill the
 * vitest process with a native crash (exit codes 3221225477 / 3221226356 /
 * 3221226505, shown as 127 or 139 by Git Bash/npx) right after the `RUN` banner,
 * and no test output. Builds that do not overlap never crash, so the files that
 * build take this lock around the build.
 *
 * The lock directory holds an `owner` file with the PID of the process that took
 * it. Staleness is decided by that PID: a lock whose owner no longer exists (a
 * crashed worker) is taken over at once. Age is only a fallback, for PID reuse
 * (10 minutes) and for a lock that never got an owner file (10 seconds).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_LOCK = path.join(os.tmpdir(), 'lousho-bundle-build.lock');
/** A lock this old is removed even when its owner PID answers (PID reuse). */
const STALE_MS = 10 * 60_000;
/** A lock with no readable owner file this old is removed (owner died before writing it). */
const NO_OWNER_STALE_MS = 10_000;
const POLL_MS = 50;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lock: string): number | undefined {
  try {
    const text = fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim();
    const pid = Number(text);
    return /^\d+$/.test(text) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function removeLock(lock: string): void {
  fs.rmSync(lock, { recursive: true, force: true });
}

function isStale(lock: string): boolean {
  const stat = fs.statSync(lock, { throwIfNoEntry: false });
  if (!stat) return false;
  const age = Date.now() - stat.mtimeMs;
  const owner = readOwner(lock);
  if (owner === undefined) return age > NO_OWNER_STALE_MS;
  return !isAlive(owner) || age > STALE_MS;
}

/** Creates a machine-wide build lock at `lockPath`; the lock path is injectable for tests. */
export function createBuildLock(lockPath: string): {
  withBuildLock: <T>(build: () => Promise<T>) => Promise<T>;
} {
  function tryAcquire(): boolean {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'owner'), String(process.pid));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStale(lockPath)) removeLock(lockPath);
      return false;
    }
  }

  /** Runs `build` while holding the lock, so no two bundle builds overlap. */
  async function withBuildLock<T>(build: () => Promise<T>): Promise<T> {
    while (!tryAcquire()) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      return await build();
    } finally {
      removeLock(lockPath);
    }
  }

  return { withBuildLock };
}

export const withBuildLock = createBuildLock(DEFAULT_LOCK).withBuildLock;
