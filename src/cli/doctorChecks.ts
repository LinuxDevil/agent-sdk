/**
 * The individual `loushy doctor` checks. Each is a small function over the
 * injected DoctorEnvironment returning one or more DoctorCheck lines.
 */
import { listProviders, modelFromEnv, type ProviderInfo } from '../providers/providerSpec';
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
  return range ? `npm install ${name}@${range}` : `npm install ${name}`;
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

interface OptionalPeer {
  providers: string[];
  /** The `npm install` argument from providerSpec.ts, e.g. `@ai-sdk/openai@^0.0.42`. */
  install: string;
}

/** The optional peer packages behind the providers, each with the providers that need it. */
function optionalPeerProviders(): Map<string, OptionalPeer> {
  const peers = new Map<string, OptionalPeer>();
  for (const info of listProviders()) {
    const existing = peers.get(info.peerPackage);
    peers.set(info.peerPackage, {
      providers: [...(existing?.providers ?? []), info.name],
      install: info.peerInstall,
    });
  }
  return peers;
}

function checkOptionalPeer(
  env: DoctorEnvironment,
  name: string,
  peer: OptionalPeer,
  needs: SpecNeeds
): DoctorCheck {
  const required = peer.providers.some((provider) => needs.providers.has(provider));
  const fix = `npm install ${peer.install}`;
  const base = { id: `optional-peer.${name}`, title: `Provider package ${name}` };
  const version = env.resolvePackageVersion(name);
  if (version === null) {
    return {
      ...base,
      status: required ? 'fail' : 'warn',
      finding: required ? 'not installed, and the agent spec needs it' : 'not installed (optional)',
      fix,
    };
  }
  const range = env.sdk.peerDependencies?.[name];
  if (range && !satisfiesRange(version, range)) {
    return {
      ...base,
      status: required ? 'fail' : 'warn',
      finding: `${version} installed, but the SDK expects ${range}`,
      fix,
    };
  }
  return { ...base, status: 'ok', finding: `${version} installed` };
}

export function checkOptionalPeers(env: DoctorEnvironment, needs: SpecNeeds): DoctorCheck[] {
  return [...optionalPeerProviders()].map(([name, peer]) => checkOptionalPeer(env, name, peer, needs));
}

function checkApiKey(env: DoctorEnvironment, info: ProviderInfo, needs: SpecNeeds): DoctorCheck {
  const base = { id: `env.${info.name}`, title: `${info.name} (${info.envKey})` };
  if (env.env[info.envKey]) return { ...base, status: 'ok', finding: 'set' };
  if (!info.envRequired) {
    return { ...base, status: 'ok', finding: 'not set (optional; the provider default endpoint is used)' };
  }
  const needed = needs.providers.has(info.name);
  return {
    ...base,
    status: needed ? 'fail' : 'warn',
    finding: needed ? 'not set, and the agent spec needs it' : 'not set',
    fix: `Set ${info.envKey} in your environment, e.g. export ${info.envKey}=<your key>`,
  };
}

/** Which provider `createAgent()` would pick with no model or provider argument. */
function checkDefaultProvider(env: DoctorEnvironment): DoctorCheck {
  const base = { id: 'env.default', title: 'Default provider for createAgent()' };
  try {
    return { ...base, status: 'ok', finding: `would use '${modelFromEnv('createAgent', env.env)}'` };
  } catch {
    return {
      ...base,
      status: 'warn',
      finding: 'none configured (createAgent() needs a model, a provider instance, or an env var)',
      fix: 'Set LOUSHY_MODEL (e.g. openai/gpt-4o-mini) or one of the API key variables above.',
    };
  }
}

/** Reports only whether each provider's env var is set - never its value. */
export function checkApiKeys(env: DoctorEnvironment, needs: SpecNeeds): DoctorCheck[] {
  return [...listProviders().map((info) => checkApiKey(env, info, needs)), checkDefaultProvider(env)];
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
