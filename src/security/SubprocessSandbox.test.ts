import { afterEach, describe, it, expect, vi } from 'vitest';
import type Docker from 'dockerode';
import { SubprocessSandbox, SandboxAdapter } from './sandbox';
import { dockerAvailable } from './docker.testkit';

/**
 * The integration block at the bottom needs a live Docker daemon and skips
 * without one (shared check: docker.testkit.ts, a top-level await so it
 * resolves before `describe.skipIf` is evaluated). The real-daemon egress and
 * broker cases live in sandboxEgress.docker.test.ts (`npm run test:docker`).
 */
const hasDocker = await dockerAvailable();

describe('SubprocessSandbox', () => {
  it('module compiles and exports a SubprocessSandbox class', () => {
    expect(SubprocessSandbox).toBeDefined();
  });

  it('constructed instance matches the SandboxAdapter interface shape (name, run, writeFile) without needing a live daemon', () => {
    // Constructing the dockerode client itself doesn't connect to the
    // daemon - only actual API calls (ping/createContainer/etc) do - so
    // this assertion is safe to run unconditionally.
    const sandbox: SandboxAdapter = new SubprocessSandbox();
    expect(sandbox.name).toBe('docker');
    expect(typeof sandbox.run).toBe('function');
    expect(typeof sandbox.writeFile).toBe('function');
  });

  describe('container options (dockerode fake, no daemon needed)', () => {
    afterEach(() => {
      vi.doUnmock('dockerode');
      vi.resetModules();
    });

    /** Loads sandbox.ts against a fake dockerode that records every createContainer() options object. */
    async function withFakeDocker() {
      const created: Docker.ContainerCreateOptions[] = [];
      class FakeDocker {
        modem = { demuxStream: () => {} };
        async createContainer(options: Docker.ContainerCreateOptions) {
          created.push(options);
          return { attach: async () => ({}), start: async () => {}, wait: async () => ({ StatusCode: 0 }), kill: async () => {} };
        }
      }
      vi.resetModules();
      vi.doMock('dockerode', () => ({ default: FakeDocker }));
      const sandboxModule = await import('./sandbox');
      const shellModule = await import('../tools/workspace/SandboxShell');
      return { created, Sandbox: sandboxModule.SubprocessSandbox, Shell: shellModule.SandboxShell };
    }

    it('is auto-removed, mounts only cwd, and has no network by default', async () => {
      const { created, Sandbox } = await withFakeDocker();
      await new Sandbox().run('sh', ['-c', 'ls'], { cwd: '/work' });
      expect(created[0]).toMatchObject({ Cmd: ['sh', '-c', 'ls'], WorkingDir: '/work' });
      expect(created[0].HostConfig).toEqual({ NetworkMode: 'none', AutoRemove: true, Binds: ['/work:/work'] });
    });

    it('maps the network policy, failing closed for { allow } without an egress proxy (LOU-X11)', async () => {
      const { created, Sandbox } = await withFakeDocker();
      await new Sandbox({ network: 'default' }).run('ls', []);
      await new Sandbox({ network: 'none' }).run('ls', []);
      const allowed = new Sandbox({ network: { allow: ['API.github.com', '*.npmjs.org'] } });
      await allowed.run('ls', []);
      expect(created.map((options) => options.HostConfig?.NetworkMode)).toEqual(['default', 'none', 'none']);
      expect(allowed.network).toEqual({ allow: ['api.github.com', '*.npmjs.org'] });
      expect(() => new Sandbox({ network: { allow: ['https://evil.example/path'] } })).toThrow(/host names/);
      expect(() => new Sandbox({ network: { allow: ['a..b'] } })).toThrow(/host names/);
      expect(() => new Sandbox({ network: 'bridge' as 'none' })).toThrow(/'none', 'default' or \{ allow/);
    });

    it('passes the SandboxShell allowlisted env into the container, never the host env (LOU-X11)', async () => {
      process.env.FAKE_SECRET_FOR_TEST = 'fake-secret-x11';
      process.env.FAKE_ALLOWED_FOR_TEST = 'allowed-x11';
      try {
        const { created, Sandbox, Shell } = await withFakeDocker();
        await new Shell(new Sandbox(), { env: { FOO: 'bar' }, inheritEnv: ['FAKE_ALLOWED_FOR_TEST'] }).exec('env');
        await new Shell(new Sandbox(), { inheritEnv: true }).exec('env');
        expect(created[0].Env).toEqual(['FAKE_ALLOWED_FOR_TEST=allowed-x11', 'FOO=bar']);
        expect(created[1].Env).toEqual([]);
      } finally {
        delete process.env.FAKE_SECRET_FOR_TEST;
        delete process.env.FAKE_ALLOWED_FOR_TEST;
      }
    });
  });

  describe('cancellation (dockerode fake, LOU-U23)', () => {
    afterEach(() => {
      vi.doUnmock('dockerode');
      vi.resetModules();
    });

    /** Loads sandbox.ts against a fake daemon whose container exits only on `finish()` or a kill. */
    async function withHangingDocker(overrides: { kill?: () => Promise<void>; remove?: () => Promise<void> } = {}) {
      const calls: string[] = [];
      let finish: (value: { StatusCode: number }) => void = () => {};
      const container = {
        attach: async () => ({}),
        start: async () => {
          calls.push('start');
        },
        wait: () => new Promise<{ StatusCode: number }>((resolve) => (finish = resolve)),
        kill: async () => {
          calls.push('kill');
          if (overrides.kill) return overrides.kill();
          finish({ StatusCode: 137 });
        },
        remove: async (options?: { force?: boolean }) => {
          calls.push(`remove:${options?.force}`);
          if (overrides.remove) return overrides.remove();
        },
      };
      let created = 0;
      class FakeDocker {
        modem = { demuxStream: () => {} };
        async createContainer() {
          created += 1;
          return container;
        }
      }
      vi.resetModules();
      vi.doMock('dockerode', () => ({ default: FakeDocker }));
      const { SubprocessSandbox: Sandbox } = await import('./sandbox');
      const { SandboxShell: Shell } = await import('../tools/workspace/SandboxShell');
      return { calls, created: () => created, finish: (code: number) => finish({ StatusCode: code }), Sandbox, Shell };
    }

    it('kills and force-removes the container when the signal aborts mid-run, and rejects with an AbortError', async () => {
      const { calls, Sandbox } = await withHangingDocker();
      const controller = new AbortController();
      const running = new Sandbox().run('sleep', ['60'], { signal: controller.signal });
      await vi.waitFor(() => expect(calls).toContain('start'));
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(calls).toEqual(['start', 'kill', 'remove:true']));
    });

    it('starts no container when the signal is already aborted', async () => {
      const { created, Sandbox } = await withHangingDocker();
      await expect(new Sandbox().run('ls', [], { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
      expect(created()).toBe(0);
    });

    it('does nothing when the signal aborts after the command finished', async () => {
      const { calls, finish, Sandbox } = await withHangingDocker();
      const controller = new AbortController();
      const running = new Sandbox().run('ls', [], { signal: controller.signal });
      await vi.waitFor(() => expect(calls).toContain('start'));
      finish(0);
      await expect(running).resolves.toMatchObject({ exitCode: 0 });
      controller.abort();
      expect(calls).toEqual(['start']);
    });

    it('a timeout uses the same cleanup, once, and rejects with the timed-out error', async () => {
      const { calls, Sandbox } = await withHangingDocker();
      const controller = new AbortController();
      await expect(new Sandbox().run('sleep', ['60'], { timeoutMs: 20, signal: controller.signal })).rejects.toThrow(/timed out after 20ms/);
      controller.abort();
      await vi.waitFor(() => expect(calls).toEqual(['start', 'kill', 'remove:true']));
      expect(calls.filter((call) => call.startsWith('remove'))).toHaveLength(1);
    });

    it('swallows "already stopped" and "already removed" errors from kill and remove', async () => {
      const { calls, Sandbox } = await withHangingDocker({
        kill: () => Promise.reject(new Error('container is not running')),
        remove: () => Promise.reject(new Error('no such container')),
      });
      const controller = new AbortController();
      const running = new Sandbox().run('sleep', ['60'], { signal: controller.signal });
      await vi.waitFor(() => expect(calls).toContain('start'));
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(calls).toEqual(['start', 'kill', 'remove:true']));
    });

    it('SandboxShell passes the signal down and reports the command as aborted', async () => {
      const { calls, Sandbox, Shell } = await withHangingDocker();
      const controller = new AbortController();
      const running = new Shell(new Sandbox()).exec('sleep 60', { signal: controller.signal, timeoutMs: 60_000 });
      await vi.waitFor(() => expect(calls).toContain('start'));
      controller.abort();
      await expect(running).resolves.toMatchObject({ aborted: true, exitCode: null });
      await vi.waitFor(() => expect(calls).toEqual(['start', 'kill', 'remove:true']));
    });
  });

  describe.skipIf(!hasDocker)('integration (requires a running Docker daemon)', () => {
    it('run() executes a command in a container and returns matching stdout/exitCode', async () => {
      const sandbox = new SubprocessSandbox({ image: 'node:20-alpine' });
      const result = await sandbox.run('node', ['-e', 'console.log("hello")']);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
    }, 60000);

    it('run() surfaces a non-zero exit code', async () => {
      const sandbox = new SubprocessSandbox({ image: 'node:20-alpine' });
      const result = await sandbox.run('node', ['-e', 'process.exit(3)']);
      expect(result.exitCode).toBe(3);
    }, 60000);
  });
});
