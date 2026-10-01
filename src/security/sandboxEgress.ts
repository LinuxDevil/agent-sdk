/**
 * Allowlisted egress for SubprocessSandbox containers (LOU-X12.2).
 *
 * The container joins an internal Docker network (`Internal: true`: no route
 * off the bridge) and the credential broker listens on that network's gateway
 * address, which on Docker Engine for Linux is the host's own interface on the
 * bridge. The broker is then the only thing the container can talk to (plus
 * any other host service listening on that address or on all addresses), so
 * its allowlist is enforced. Anywhere that cannot hold (Docker Desktop, a
 * remote or rootless daemon, an Engine that forwards DNS from internal
 * networks) fails closed with LOUSHY_SANDBOX_EGRESS_UNSUPPORTED.
 *
 * Node-only, like sandbox.ts.
 */

import { isIPv4 } from 'node:net';
import type Docker from 'dockerode';
import { SDKError } from '../execution/errors';
import type { CredentialBroker } from './credentialBroker';

/** Label on networks the SDK creates. */
const MANAGED_LABEL = 'com.loushy.sandbox';

/** The internal network and broker listener a sandbox's containers use. */
export interface Egress {
  readonly network: string;
  /** Proxy variables pointing at the broker's listener on the network gateway. Hold no secret. */
  readonly env: Readonly<Record<string, string>>;
  /** Stops the listener and removes the network if this sandbox created it. */
  close(): Promise<void>;
}

/** Runs `fn` and ignores its failure (e.g. a container or network that is already gone). */
export async function ignoreFailure(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* already stopped or removed */
  }
}

function unsupported(reason: string, cause?: unknown): SDKError {
  return new SDKError(
    `SubprocessSandbox: network { allow } with a broker cannot be enforced here: ${reason}. No container was started.`,
    'LOUSHY_SANDBOX_EGRESS_UNSUPPORTED',
    { cause }
  );
}

/** The fields of `docker.info()` this module reads. */
interface EngineInfo {
  OperatingSystem?: string;
  ServerVersion?: string;
  SecurityOptions?: string[];
}

/** Engine 25.0.5 / 26.0.0 stopped forwarding DNS from internal networks (CVE-2024-29018). */
function forwardsDns(version = ''): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map(Number);
  return major < 25 || (major === 25 && minor === 0 && patch < 5) || Number.isNaN(major + minor + patch);
}

/** Why this daemon cannot give the guarantee, or `undefined` when it can. */
function engineBlocker(info: EngineInfo): string | undefined {
  if (/docker desktop/i.test(info.OperatingSystem ?? '')) {
    return 'Docker Desktop runs containers in a VM, so this host has no address on an internal network';
  }
  if (info.SecurityOptions?.some((option) => option.includes('rootless'))) {
    return "rootless Docker keeps the bridge in its own network namespace, out of the broker's reach";
  }
  if (forwardsDns(info.ServerVersion)) {
    return `Docker Engine ${info.ServerVersion ?? '(unknown)'} forwards DNS from internal networks; 25.0.5 or later is needed`;
  }
  return undefined;
}

/** Inspects `name`, creating it as an internal, SDK-labelled bridge network when it does not exist. */
async function openNetwork(docker: Docker, name: string): Promise<{ info: Docker.NetworkInspectInfo; created: boolean }> {
  try {
    return { info: await docker.getNetwork(name).inspect(), created: false };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  const network = await docker.createNetwork({
    Name: name,
    Driver: 'bridge',
    Internal: true,
    EnableIPv6: false,
    CheckDuplicate: true,
    Labels: { [MANAGED_LABEL]: 'egress' },
  });
  return { info: await network.inspect(), created: true };
}

/** The network's IPv4 subnet and gateway (the host's address on the bridge). */
function gatewayOf(info: Docker.NetworkInspectInfo): { Subnet: string; Gateway: string } {
  if (!info.Internal) throw unsupported(`the existing network '${info.Name}' is not internal, so it has a route out`);
  const configs = (info.IPAM?.Config ?? []) as Array<{ Subnet?: string; Gateway?: string }>;
  const config = configs.find((c) => c.Subnet && c.Gateway && isIPv4(c.Gateway));
  if (!config?.Subnet || !config.Gateway) throw unsupported(`network '${info.Name}' has no IPv4 gateway address on the host`);
  return { Subnet: config.Subnet, Gateway: config.Gateway };
}

/**
 * Checks the daemon, creates or reuses the internal network `name` and has
 * `broker` listen on its gateway for that subnet only, with `allow` (plus the
 * broker's rule hosts) as that listener's allowlist.
 */
export async function startEgress(docker: Docker, broker: CredentialBroker, allow: readonly string[], name: string): Promise<Egress> {
  const blocker = engineBlocker((await docker.info()) as EngineInfo);
  if (blocker) throw unsupported(blocker);
  const { info, created } = await openNetwork(docker, name);
  const removeNetwork = () => (created ? ignoreFailure(() => docker.getNetwork(name).remove()) : Promise.resolve());
  try {
    const { Subnet, Gateway } = gatewayOf(info);
    const listener = await broker.listen({ host: Gateway, clients: Subnet, allow }).catch((error: unknown) => {
      throw unsupported(`the broker cannot listen on the gateway ${Gateway}, so this host is not on the bridge (a remote daemon?)`, error);
    });
    const close = async () => {
      await listener.close();
      await removeNetwork();
    };
    return { network: name, env: listener.env, close };
  } catch (error) {
    await removeNetwork();
    throw error;
  }
}
