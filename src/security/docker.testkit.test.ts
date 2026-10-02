/**
 * LOU-M6: the real-daemon suite's gate (docker.testkit.ts) skips without a
 * daemon, fails under LOUSHO_DOCKER_TESTS=1, and treats Docker Desktop and
 * rootless daemons as absent for the egress suite. Against a dockerode fake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('dockerode');
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Loads docker.testkit.ts against a fake dockerode whose ping and info behave as given. */
async function load(daemon: { ping: () => Promise<unknown>; info?: Record<string, unknown> }) {
  class FakeDocker {
    ping = daemon.ping;
    async info() {
      return daemon.info ?? {};
    }
  }
  vi.resetModules();
  vi.doMock('dockerode', () => ({ default: FakeDocker }));
  return import('./docker.testkit');
}

const up = () => Promise.resolve('OK');
const down = () => Promise.reject(new Error('connect ENOENT /var/run/docker.sock'));
const LINUX = { OperatingSystem: 'Ubuntu 24.04.5 LTS', SecurityOptions: ['name=seccomp,profile=builtin'] };

describe('docker.testkit (LOU-M6)', () => {
  it('dockerAvailable() is true when the daemon answers and false when it refuses', async () => {
    expect(await (await load({ ping: up })).dockerAvailable()).toBe(true);
    expect(await (await load({ ping: down })).dockerAvailable()).toBe(false);
  });

  it('dockerAvailable() gives up after 2 seconds on a daemon that never answers', async () => {
    vi.useFakeTimers();
    const { dockerAvailable } = await load({ ping: () => new Promise(() => {}) });
    const answer = dockerAvailable();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await answer).toBe(false);
  });

  it('requireDocker() skips without a daemon, and fails instead under LOUSHO_DOCKER_TESTS=1', async () => {
    expect(await (await load({ ping: down })).requireDocker()).toBe(false);
    vi.stubEnv('LOUSHO_DOCKER_TESTS', '1');
    await expect((await load({ ping: down })).requireDocker()).rejects.toThrow(/LOUSHO_DOCKER_TESTS=1 is set but no Docker daemon answered/);
  });

  it('requireDocker({ linuxEngine: true }) runs on a rootful Linux Engine and skips on Docker Desktop or rootless', async () => {
    expect(await (await load({ ping: up, info: LINUX })).requireDocker({ linuxEngine: true })).toBe(true);
    expect(await (await load({ ping: up, info: { OperatingSystem: 'Docker Desktop' } })).requireDocker({ linuxEngine: true })).toBe(false);
    const rootless = { ...LINUX, SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'] };
    expect(await (await load({ ping: up, info: rootless })).requireDocker({ linuxEngine: true })).toBe(false);
    // Without linuxEngine, any answering daemon will do.
    expect(await (await load({ ping: up, info: { OperatingSystem: 'Docker Desktop' } })).requireDocker()).toBe(true);
  });

  it('under LOUSHO_DOCKER_TESTS=1 the egress suite runs even on a refused daemon, so it fails loudly', async () => {
    vi.stubEnv('LOUSHO_DOCKER_TESTS', '1');
    expect(await (await load({ ping: up, info: { OperatingSystem: 'Docker Desktop' } })).requireDocker({ linuxEngine: true })).toBe(true);
  });
});
