/**
 * LOU-M6: SubprocessSandbox `network: { allow }` with a credential broker,
 * against a real Docker Engine on Linux (sandboxEgress.test.ts covers the same
 * code against a dockerode fake).
 *
 * Runs only through `npm run test:docker` (vitest.docker.config.ts). The Linux
 * Docker CI job (.github/workflows/docker.yml) pre-pulls the image and sets
 * LOUSHO_DOCKER_TESTS=1, so the suite fails there rather than skipping when no
 * daemon answers. Cases 1, 3 and 4 need the runner's internet access.
 *
 * The broker's secret is a random test value; assertions check its presence
 * on the host side and its absence in the container, never print it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import Docker from 'dockerode';
import { SubprocessSandbox } from './sandbox';
import { createCredentialBroker, type CredentialBroker } from './credentialBroker';
import { requireDocker } from './docker.testkit';

// Skips on Docker Desktop and rootless daemons (refused by design) unless LOUSHO_DOCKER_TESTS=1.
const hasDocker = await requireDocker({ linuxEngine: true });

/** Honours HTTP(S)_PROXY, tunnels HTTPS with CONNECT; pinned so the test does not drift. */
const IMAGE = 'curlimages/curl:8.10.1';
const PREFIX = `lousho-m6-${randomBytes(3).toString('hex')}`;
const CURL = ['-sS', '--connect-timeout', '5', '--max-time', '20'];

/** A host-side HTTP server on 127.0.0.1 (and ::1 when available) that records each request's path and Authorization header. */
async function startEcho() {
  const hits: Array<{ path: string; authorization?: string }> = [];
  const handler: http.RequestListener = (req, res) => {
    hits.push({ path: req.url ?? '', authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('echo-ok\n');
  };
  const v4 = http.createServer(handler);
  await new Promise<void>((resolve) => v4.listen(0, '127.0.0.1', resolve));
  const port = (v4.address() as AddressInfo).port;
  // `localhost` may resolve to ::1 first; answer there on the same port too.
  const v6 = http.createServer(handler);
  const v6Up = await new Promise<boolean>((resolve) => {
    v6.once('error', () => resolve(false));
    v6.listen(port, '::1', () => resolve(true));
  });
  const close = async () => {
    await new Promise<void>((resolve) => v4.close(() => resolve()));
    if (v6Up) await new Promise<void>((resolve) => v6.close(() => resolve()));
  };
  return { hits, port, close };
}

/** Containers attached to `network`, running or not. */
async function containersOn(docker: Docker, network: string): Promise<Docker.ContainerInfo[]> {
  return docker.listContainers({ all: true, filters: { network: [network] } });
}

/** Resolves with the network's inspect info, or `undefined` once it is gone. */
async function inspectNetwork(docker: Docker, name: string): Promise<Docker.NetworkInspectInfo | undefined> {
  try {
    return await docker.getNetwork(name).inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw error;
  }
}

describe.skipIf(!hasDocker)('SubprocessSandbox egress on a real Docker Engine', () => {
  const docker = new Docker();
  const secret = `m6-test-secret-${randomBytes(12).toString('hex')}`;
  const network = `${PREFIX}-net`;
  let echo: Awaited<ReturnType<typeof startEcho>>;
  let broker: CredentialBroker;
  let sandbox: SubprocessSandbox;

  const curl = (...args: string[]) => sandbox.run('curl', [...CURL, ...args]);

  beforeAll(async () => {
    const info = (await docker.info()) as { ServerVersion?: string; OperatingSystem?: string; SecurityOptions?: string[] };
    console.log(`Docker Engine ${info.ServerVersion} on ${info.OperatingSystem}; security options: ${info.SecurityOptions?.join(', ')}`);
    echo = await startEcho();
    broker = await createCredentialBroker({
      rules: { localhost: { authorization: `Bearer ${secret}` } },
      allowPrivate: ['localhost'],
    });
    sandbox = new SubprocessSandbox({ image: IMAGE, network: { allow: ['example.com'] }, broker, networkName: network });
  });

  afterAll(async () => {
    await sandbox?.close();
    await broker?.close();
    await echo?.close();
    // Leftovers from a failed case; a passing run has removed them already.
    for (const name of [network, `${PREFIX}-abort`, `${PREFIX}-open`]) {
      await docker.getNetwork(name).remove().catch(() => undefined);
    }
  });

  it('1. an allowed host over HTTPS goes through the broker and answers 200', async () => {
    const result = await curl('-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('200');
  });

  it('2. a host not in allow is refused by the broker with 403', async () => {
    const result = await curl('-o', '/dev/null', 'https://example.org/');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/403/);
  });

  it('3. bypassing the proxy fails: the internal network has no route out', async () => {
    const [{ address }] = await lookup('example.com', { family: 4, all: true });
    const result = await curl('--noproxy', '*', '--resolve', `example.com:443:${address}`, '-o', '/dev/null', 'https://example.com/');
    expect(result.exitCode).not.toBe(0);
    // 7: could not connect (network unreachable); 28: timed out.
    expect([7, 28]).toContain(result.exitCode);
  });

  it('4. a raw IP fails, directly and through the broker', async () => {
    const direct = await curl('--noproxy', '*', '-o', '/dev/null', 'https://1.1.1.1/');
    expect([7, 28]).toContain(direct.exitCode);
    const proxied = await curl('-o', '/dev/null', 'https://1.1.1.1/');
    expect(proxied.exitCode).not.toBe(0);
    expect(proxied.stderr).toMatch(/403/);
  });

  it('5. DNS inside the container does not resolve external names', async () => {
    const result = await curl('--noproxy', '*', '-o', '/dev/null', 'https://example.com/');
    // 6: could not resolve host.
    expect(result.exitCode).toBe(6);
  });

  it('6. the broker injects the credential for a plain-HTTP target; the container never sees it', async () => {
    const path = `/m6-inject-${randomBytes(4).toString('hex')}`;
    const result = await sandbox.run('sh', ['-c', `env; curl ${CURL.join(' ')} http://localhost:${echo.port}${path}`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo-ok');
    expect(result.stdout).toMatch(/^HTTPS_PROXY=http:\/\/[\d.]+:\d+$/m);
    const leaked = result.stdout.includes(secret) || result.stderr.includes(secret);
    expect(leaked, 'the secret must not appear in the container').toBe(false);
    const hit = echo.hits.find((h) => h.path === path);
    expect(hit, 'the echo server was reached through the broker').toBeDefined();
    expect(hit?.authorization === `Bearer ${secret}`, 'the broker injected the configured header').toBe(true);
  });

  it('7. a container outside the internal network cannot use the gateway listener', async () => {
    const proxy = (await sandbox.run('sh', ['-c', 'printf %s "$HTTP_PROXY"'])).stdout;
    expect(proxy).toMatch(/^http:\/\/[\d.]+:\d+$/);
    const path = `/m6-outsider-${randomBytes(4).toString('hex')}`;
    const outsider = new SubprocessSandbox({ image: IMAGE, network: 'default' });
    const result = await outsider.run('curl', [...CURL, '-x', proxy, '-o', '/dev/null', `http://localhost:${echo.port}${path}`]);
    expect(result.exitCode).not.toBe(0);
    expect(echo.hits.some((h) => h.path === path)).toBe(false);
  });

  it('8. an aborted run() leaves no container, and close() removes the SDK-created network', async () => {
    const name = `${PREFIX}-abort`;
    const aborting = new SubprocessSandbox({ image: IMAGE, network: { allow: ['example.com'] }, broker, networkName: name });
    const controller = new AbortController();
    const running = aborting.run('sh', ['-c', 'sleep 60'], { signal: controller.signal });
    running.catch(() => undefined);
    await vi.waitFor(async () => expect(await containersOn(docker, name)).toHaveLength(1), { timeout: 60_000, interval: 250 });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect(await containersOn(docker, name)).toEqual([]), { timeout: 30_000, interval: 250 });

    const created = await inspectNetwork(docker, name);
    expect(created?.Internal).toBe(true);
    expect(created?.Labels?.['com.lousho.sandbox']).toBe('egress');
    await aborting.close();
    expect(await inspectNetwork(docker, name)).toBeUndefined();
  });

  it('9. a reused network that is not internal is refused, and is left in place', async () => {
    const name = `${PREFIX}-open`;
    await docker.createNetwork({ Name: name, Driver: 'bridge', Internal: false });
    try {
      const reusing = new SubprocessSandbox({ image: IMAGE, network: { allow: ['example.com'] }, broker, networkName: name });
      await expect(reusing.run('curl', ['--version'])).rejects.toMatchObject({
        code: 'LOUSHO_SANDBOX_EGRESS_UNSUPPORTED',
        detail: expect.stringContaining(`the existing network '${name}' is not internal`),
      });
      expect(await containersOn(docker, name)).toEqual([]);
      await reusing.close();
      expect(await inspectNetwork(docker, name)).toBeDefined();
    } finally {
      await docker.getNetwork(name).remove().catch(() => undefined);
    }
  });
});
