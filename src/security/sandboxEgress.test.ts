/**
 * LOU-X12.2: SubprocessSandbox routes `network: { allow }` through the
 * credential broker on an internal Docker network. Runs against a dockerode
 * fake (no daemon) and a fake broker whose listen() calls are recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Docker from 'dockerode';
import type { BrokerListenOptions, CredentialBroker } from './credentialBroker';

const SECRET = 'fake-broker-secret-x12-2';
const GATEWAY = '172.30.0.1';
const SUBNET = '172.30.0.0/16';
const LINUX_ENGINE = { OperatingSystem: 'Ubuntu 24.04 LTS', ServerVersion: '28.3.2', SecurityOptions: ['name=seccomp,profile=builtin'] };

interface FakeOptions {
  info?: Record<string, unknown>;
  /** Networks that already exist, by name. */
  existing?: Record<string, Partial<Docker.NetworkInspectInfo>>;
  /** IPAM config of networks the fake creates. */
  ipam?: Array<{ Subnet?: string; Gateway?: string }>;
  hang?: boolean;
}

afterEach(() => {
  vi.doUnmock('dockerode');
  vi.resetModules();
});

/** Loads sandbox.ts against a fake dockerode that records containers, network calls and container calls. */
async function setup(fake: FakeOptions = {}) {
  const calls: string[] = [];
  const containers: Docker.ContainerCreateOptions[] = [];
  const networks: Docker.NetworkCreateOptions[] = [];
  const existing = new Map(Object.entries(fake.existing ?? {}));
  let finish: (value: { StatusCode: number }) => void = () => {};
  class FakeDocker {
    modem = { demuxStream: () => {} };
    async info() {
      return fake.info ?? LINUX_ENGINE;
    }
    getNetwork(name: string) {
      return {
        inspect: async () => {
          const info = existing.get(name);
          if (!info) throw Object.assign(new Error('network not found'), { statusCode: 404 });
          return { Name: name, ...info };
        },
        remove: async () => {
          calls.push(`network.remove:${name}`);
          existing.delete(name);
        },
      };
    }
    async createNetwork(options: Docker.NetworkCreateOptions) {
      networks.push(options);
      existing.set(options.Name, { Internal: options.Internal, IPAM: { Driver: 'default', Config: fake.ipam ?? [{ Subnet: SUBNET, Gateway: GATEWAY }] } });
      return this.getNetwork(options.Name);
    }
    async createContainer(options: Docker.ContainerCreateOptions) {
      containers.push(options);
      return {
        attach: async () => ({}),
        start: async () => calls.push('start'),
        wait: () => (fake.hang ? new Promise((resolve) => (finish = resolve)) : Promise.resolve({ StatusCode: 0 })),
        kill: async () => {
          calls.push('kill');
          finish({ StatusCode: 137 });
        },
        remove: async () => calls.push('container.remove'),
      };
    }
  }
  vi.resetModules();
  vi.doMock('dockerode', () => ({ default: FakeDocker }));
  const { SubprocessSandbox } = await import('./sandbox');
  const listens: BrokerListenOptions[] = [];
  const broker: CredentialBroker = {
    url: 'http://127.0.0.1:1',
    env: {},
    baseUrl: (host) => host,
    listen: async (options) => {
      listens.push(options);
      const url = `http://${options.host}:40000`;
      return { url, env: { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: options.host }, close: async () => void calls.push('listener.close') };
    },
    close: async () => {},
  };
  return { calls, containers, networks, listens, broker, existing, SubprocessSandbox };
}

describe('SubprocessSandbox egress through the credential broker (LOU-X12.2)', () => {
  it('creates a labelled internal network, has the broker listen on its gateway for its subnet, and starts the container on it', async () => {
    const { calls, containers, networks, listens, broker, SubprocessSandbox } = await setup();
    const sandbox = new SubprocessSandbox({ network: { allow: ['registry.npmjs.org'] }, broker, networkName: 'lousho-egress-test' });
    await sandbox.run('npm', ['ci'], { env: { CI: '1', HTTP_PROXY: 'http://evil.example:1' } });
    await sandbox.run('npm', ['test']);

    expect(networks).toEqual([
      { Name: 'lousho-egress-test', Driver: 'bridge', Internal: true, EnableIPv6: false, CheckDuplicate: true, Labels: { 'com.lousho.sandbox': 'egress' } },
    ]);
    expect(listens).toEqual([{ host: GATEWAY, clients: SUBNET, allow: ['registry.npmjs.org'] }]);
    expect(containers[0].HostConfig).toMatchObject({ NetworkMode: 'lousho-egress-test', AutoRemove: true });
    expect(containers[0].NetworkingConfig).toEqual({ EndpointsConfig: { 'lousho-egress-test': {} } });
    expect(containers[0].Env).toEqual(['CI=1', `HTTP_PROXY=http://${GATEWAY}:40000`, `HTTPS_PROXY=http://${GATEWAY}:40000`, `NO_PROXY=${GATEWAY}`]);
    expect(containers[1].HostConfig?.NetworkMode).toBe('lousho-egress-test');
    expect(JSON.stringify(containers)).not.toContain(SECRET);

    await sandbox.close();
    expect(calls.filter((call) => !['start', 'container.remove'].includes(call))).toEqual(['listener.close', 'network.remove:lousho-egress-test']);
  });

  it('reuses an existing internal network and leaves it in place on close()', async () => {
    const internal = { Internal: true, IPAM: { Driver: 'default', Config: [{ Subnet: SUBNET, Gateway: GATEWAY }] } };
    const { calls, networks, listens, broker, existing, SubprocessSandbox } = await setup({ existing: { shared: internal } });
    const sandbox = new SubprocessSandbox({ network: { allow: [] }, broker, networkName: 'shared' });
    await sandbox.run('ls', []);
    await sandbox.close();
    expect(networks).toEqual([]);
    expect(listens).toHaveLength(1);
    expect(calls).toContain('listener.close');
    expect(calls).not.toContain('network.remove:shared');
    expect(existing.has('shared')).toBe(true);
  });

  it('a default network name is fresh per sandbox', async () => {
    const { networks, broker, SubprocessSandbox } = await setup();
    await new SubprocessSandbox({ network: { allow: [] }, broker }).run('ls', []);
    await new SubprocessSandbox({ network: { allow: [] }, broker }).run('ls', []);
    expect(networks[0].Name).toMatch(/^lousho-egress-[0-9a-f]{8}$/);
    expect(networks[1].Name).not.toBe(networks[0].Name);
  });

  it('an aborted run kills and removes its container, and close() then leaves no network behind', async () => {
    const { calls, broker, SubprocessSandbox } = await setup({ hang: true });
    const sandbox = new SubprocessSandbox({ network: { allow: ['api.github.com'] }, broker, networkName: 'n' });
    const controller = new AbortController();
    const running = sandbox.run('sleep', ['60'], { signal: controller.signal });
    await vi.waitFor(() => expect(calls).toContain('start'));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await sandbox.close();
    expect(calls).toEqual(['start', 'kill', 'container.remove', 'listener.close', 'network.remove:n']);
  });

  it('without a broker, { allow } stays fail-closed and no network is created', async () => {
    const { containers, networks, SubprocessSandbox } = await setup();
    await new SubprocessSandbox({ network: { allow: ['api.github.com'] } }).run('ls', []);
    expect(containers[0].HostConfig?.NetworkMode).toBe('none');
    expect(containers[0].NetworkingConfig).toBeUndefined();
    expect(networks).toEqual([]);
  });

  it("'none' and 'default' ignore the broker", async () => {
    const { containers, networks, listens, broker, SubprocessSandbox } = await setup();
    await new SubprocessSandbox({ network: 'none', broker }).run('ls', []);
    await new SubprocessSandbox({ network: 'default', broker }).run('ls', []);
    expect(containers.map((c) => c.HostConfig?.NetworkMode)).toEqual(['none', 'default']);
    expect([...networks, ...listens]).toEqual([]);
  });

  it.each([
    ['Docker Desktop', { OperatingSystem: 'Docker Desktop', ServerVersion: '28.3.2' }, /Docker Desktop/],
    ['rootless Docker', { ...LINUX_ENGINE, SecurityOptions: ['name=seccomp', 'name=rootless'] }, /rootless/],
    ['an Engine that forwards DNS from internal networks', { ...LINUX_ENGINE, ServerVersion: '25.0.4' }, /forwards DNS/],
    ['an unknown Engine version', { OperatingSystem: 'Ubuntu' }, /forwards DNS/],
  ])('fails closed with a coded error on %s, before creating anything', async (_name, info, reason) => {
    const { containers, networks, broker, SubprocessSandbox } = await setup({ info });
    const run = new SubprocessSandbox({ network: { allow: ['api.github.com'] }, broker }).run('ls', []);
    await expect(run).rejects.toMatchObject({ code: 'LOUSHO_SANDBOX_EGRESS_UNSUPPORTED', message: expect.stringMatching(reason) });
    expect([...containers, ...networks]).toEqual([]);
  });

  it('fails closed when a reused network is not internal, without removing it', async () => {
    const { calls, containers, broker, SubprocessSandbox } = await setup({ existing: { open: { Internal: false } } });
    const run = new SubprocessSandbox({ network: { allow: [] }, broker, networkName: 'open' }).run('ls', []);
    await expect(run).rejects.toMatchObject({ code: 'LOUSHO_SANDBOX_EGRESS_UNSUPPORTED', message: expect.stringMatching(/not internal/) });
    expect(containers).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('fails closed and removes the network it created when there is no IPv4 gateway or the broker cannot bind it', async () => {
    const noGateway = await setup({ ipam: [{ Subnet: 'fd00::/64', Gateway: 'fd00::1' }] });
    const first = new noGateway.SubprocessSandbox({ network: { allow: [] }, broker: noGateway.broker, networkName: 'a' }).run('ls', []);
    await expect(first).rejects.toMatchObject({ code: 'LOUSHO_SANDBOX_EGRESS_UNSUPPORTED', message: expect.stringMatching(/no IPv4 gateway/) });
    expect(noGateway.calls).toEqual(['network.remove:a']);

    const remote = await setup();
    remote.broker.listen = () => Promise.reject(Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }));
    const sandbox = new remote.SubprocessSandbox({ network: { allow: [] }, broker: remote.broker, networkName: 'b' });
    await expect(sandbox.run('ls', [])).rejects.toMatchObject({ code: 'LOUSHO_SANDBOX_EGRESS_UNSUPPORTED', message: expect.stringMatching(/not on the bridge/) });
    expect(remote.calls).toEqual(['network.remove:b']);
    expect(remote.containers).toEqual([]);
    // A failed setup is not cached: the next run tries again.
    await expect(sandbox.run('ls', [])).rejects.toMatchObject({ code: 'LOUSHO_SANDBOX_EGRESS_UNSUPPORTED' });
    expect(remote.networks).toHaveLength(2);
    await sandbox.close();
  });
});
