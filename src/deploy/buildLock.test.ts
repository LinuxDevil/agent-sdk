import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBuildLock } from './buildLock.testkit.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('buildLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-buildlock-test-'));
    lockPath = path.join(dir, 'lock');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes over a lock whose owner process has exited', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), String(deadPid));
    const { withBuildLock } = createBuildLock(lockPath);
    const started = Date.now();
    await expect(withBuildLock(async () => 'done')).resolves.toBe('done');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not take over a lock whose owner is alive', async () => {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), String(process.pid));
    const { withBuildLock } = createBuildLock(lockPath);
    let finished = false;
    const run = withBuildLock(async () => {
      finished = true;
    });
    await sleep(300);
    expect(finished).toBe(false);
    fs.rmSync(lockPath, { recursive: true, force: true });
    await run;
    expect(finished).toBe(true);
  });

  it('runs overlapping builds one after the other', async () => {
    const { withBuildLock } = createBuildLock(lockPath);
    const events: string[] = [];
    const job = (name: string) =>
      withBuildLock(async () => {
        events.push(`start ${name}`);
        await sleep(100);
        events.push(`end ${name}`);
      });
    await Promise.all([job('a'), job('b')]);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatch(/^start /);
    expect(events[1]).toBe(events[0].replace('start', 'end'));
    expect(events[2]).toMatch(/^start /);
    expect(events[3]).toBe(events[2].replace('start', 'end'));
  });

  it('removes the lock directory when the build throws', async () => {
    const { withBuildLock } = createBuildLock(lockPath);
    await expect(
      withBuildLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
