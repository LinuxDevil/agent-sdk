/**
 * The individual `loushy doctor` checks. Each is a small function over the
 * injected DoctorEnvironment returning one or more DoctorCheck lines.
 */
import { PROVIDER_ENV_TABLE } from '../providers/providerEnv';
import type { DoctorCheck, DoctorEnvironment } from './doctorTypes';
import { satisfiesRange } from './versionRange';

const REQUIRED_PEERS = ['ai', 'zod'];
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_TIMEOUT_MS = 2000;

/** What the agent spec (if any) needs from the rest of the setup. */
export interface SpecNeeds {
  /** Lowercased provider types the spec uses. */
  providers: Set<string>;
  usesSandbox: boolean;
}

export const NO_SPEC_NEEDS: SpecNeeds = { providers: new Set(), usesSandbox: false };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installCommand(env: DoctorEnvironment, name: string): string {
  const range = env.sdk.peerDependencies?.[name];
  return range ? `npm install ${name}@"${range}"` : `npm install ${name}`;
}

export function checkNode(env: DoctorEnvironment): DoctorCheck {
  const range = env.sdk.engines?.node;
  const base = { id: 'node', title: 'Node.js' };
  if (!range) {
    return { ...base, status: 'ok', finding: `v${env.nodeVersion} (the SDK declares no engines.node)` };
  }
  if (satisfiesRange(env.nodeVersion, range)) {
    return { ...base, status: 'ok', finding: `v${env.nodeVersion} satisfies ${range}` };
  }
  return {
    ...base,
    status: 'fail',
    finding: `v${env.nodeVersion} does not satisfy ${range}`,
    fix: `Install a Node.js version matching "${range}" (for example with nvm: nvm install --lts).`,
  };
}

function checkRequiredPeer(env: DoctorEnvironment, name: string): DoctorCheck {
  const base = { id: `peer.${name}`, title: `Required peer ${name}` };
  const version = env.resolvePackageVersion(name);
  if (version === null) {
    return { ...base, status: 'fail', finding: 'not installed', fix: installCommand(env, name) };
  }
  const range = env.sdk.peerDependencies?.[name];
  if (range && !satisfiesRange(version, range)) {
    return {
      ...base,
      status: 'fail',
      finding: `${version} installed, but the SDK needs ${range}`,
      fix: installCommand(env, name),
    };
  }
  return { ...base, status: 'ok', finding: range ? `${version} satisfies ${range}` : `${version} installed` };
}

export function checkRequiredPeers(env: DoctorEnvironment): DoctorCheck[] {
  return REQUIRED_PEERS.map((name) => checkRequiredPeer(env, name));
}

/** The optional peer packages behind the providers, each with the providers that need it. */
function optionalPeerProviders(): Map<string, string[]> {
  const peers = new Map<string, string[]>();
  for (const [provider, entry] of Object.entries(PROVIDER_ENV_TABLE)) {
    peers.set(entry.peerPackage, [...(peers.get(entry.peerPackage) ?? []), provider]);
  }
  return peers;
}

function checkOptionalPeer(
  env: DoctorEnvironment,
  name: string,
  providers: string[],
  needs: SpecNeeds
): DoctorCheck {
  const required = providers.some((provider) => needs.providers.has(provider));
  const base = { id: `optional-peer.${name}`, title: `Provider package ${name}` };
  const version = env.resolvePackageVersion(name);
  if (version === null) {
    return {
      ...base,
      status: required ? 'fail' : 'warn',
      finding: required ? 'not installed, and the agent spec needs it' : 'not installed (optional)',
      fix: installCommand(env, name),
    };
  }
  const range = env.sdk.peerDependencies?.[name];
  if (range && !satisfiesRange(version, range)) {
    return {
      ...base,
      status: required ? 'fail' : 'warn',
      finding: `${version} installed, but the SDK expects ${range}`,
      fix: installCommand(env, name),
    };
  }
  return { ...base, status: 'ok', finding: `${version} installed` };
}

export function checkOptionalPeers(env: DoctorEnvironment, needs: SpecNeeds): DoctorCheck[] {
  return [...optionalPeerProviders()].map(([name, providers]) =>
    checkOptionalPeer(env, name, providers, needs)
  );
}

function checkApiKey(env: DoctorEnvironment, provider: string, needs: SpecNeeds): DoctorCheck {
  const entry = PROVIDER_ENV_TABLE[provider];
  const isSet = Boolean(env.env[entry.envKey]);
  const base = { id: `env.${provider}`, title: `${provider} (${entry.envKey})` };
  if (isSet) return { ...base, status: 'ok', finding: 'set' };
  if (entry.configField === 'baseURL') {
    return { ...base, status: 'ok', finding: 'not set (optional; the provider default endpoint is used)' };
  }
  return {
    ...base,
    status: needs.providers.has(provider) ? 'fail' : 'warn',
    finding: needs.providers.has(provider) ? 'not set, and the agent spec needs it' : 'not set',
    fix: `Set ${entry.envKey} in your environment, e.g. export ${entry.envKey}=<your key>`,
  };
}

/** Reports only whether each provider's env var is set - never its value. */
export function checkApiKeys(env: DoctorEnvironment, needs: SpecNeeds): DoctorCheck[] {
  return Object.keys(PROVIDER_ENV_TABLE).map((provider) => checkApiKey(env, provider, needs));
}

function ollamaBaseUrl(env: DoctorEnvironment): string {
  const raw = env.env.OLLAMA_HOST || env.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, '').replace(/\/api$/, '');
}

/** Only relevant when the spec uses Ollama or OLLAMA_HOST is set. */
export async function checkOllama(
  env: DoctorEnvironment,
  needs: SpecNeeds
): Promise<DoctorCheck | null> {
  if (!needs.providers.has('ollama') && !env.env.OLLAMA_HOST) return null;
  const base = { id: 'ollama', title: 'Ollama server' };
  try {
    const response = await env.fetch(`${ollamaBaseUrl(env)}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (response.ok) return { ...base, status: 'ok', finding: 'reachable' };
    return { ...base, status: 'warn', finding: `unreachable (HTTP ${response.status})`, fix: OLLAMA_FIX };
  } catch (error) {
    return { ...base, status: 'warn', finding: `unreachable (${message(error)})`, fix: OLLAMA_FIX };
  }
}

const OLLAMA_FIX =
  'Start it with `ollama serve`, or set OLLAMA_HOST (or OLLAMA_BASE_URL) to its address.';

/** Docker is only needed for sandboxed tools, so a missing daemon is a warning only when the spec needs one. */
export async function checkDocker(env: DoctorEnvironment, needs: SpecNeeds): Promise<DoctorCheck> {
  const base = { id: 'docker', title: 'Docker' };
  const reachable = await env.dockerReachable().catch(() => false);
  if (reachable) return { ...base, status: 'ok', finding: 'daemon reachable (sandboxed tools can run)' };
  if (needs.usesSandbox) {
    return {
      ...base,
      status: 'warn',
      finding: 'daemon not reachable, but the agent spec uses a sandboxed tool',
      fix: 'Install and start Docker (https://docs.docker.com/get-docker/), then re-run `loushy doctor`.',
    };
  }
  return {
    ...base,
    status: 'ok',
    finding: 'daemon not reachable (only needed for sandboxed tools; none configured)',
  };
}
