import { afterEach, describe, it, expect, vi } from 'vitest';
import Docker from 'dockerode';
import { SubprocessSandbox, SandboxAdapter } from './sandbox';

/**
 * SubprocessSandbox needs a live Docker daemon. This environment's `docker`
 * CLI is installed but Docker Desktop's daemon is not running (verified
 * via `docker version`, which exits non-zero here), so the integration
 * tests below are skipped at runtime rather than either failing the suite
 * or silently vanishing without explanation - see the LOU-F6 ticket's own
 * guidance and the final report for details.
 *
 * This check runs as a top-level await (vitest collects test files as
 * ESM modules, so this executes - and resolves - before `describe.skipIf`
 * below is evaluated) rather than inside a `beforeAll`, since
 * `describe.skipIf`'s condition is evaluated synchronously during test
 * collection, before any `beforeAll` hook has had a chance to run.
 */
let dockerAvailable = false;
try {
  const docker = new Docker();
  await docker.ping();
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

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

  describe.skipIf(!dockerAvailable)('integration (requires a running Docker daemon)', () => {
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
