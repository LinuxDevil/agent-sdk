/**
 * The individual `loushy doctor` checks. Each is a small function over the
 * injected DoctorEnvironment returning one or more DoctorCheck lines.
 */
import { FEATURE_PEERS } from '../providers/optionalPeer';
import { listProviders, modelFromEnv, type AiMajor, type ProviderInfo } from '../providers/providerSpec';
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

/** The newest alternative of a `||` range: `^4.3.19 || ^7.0.0` installs `^7.0.0`. */
function newestAlternative(range: string): string {
  return range.split('||').pop()!.trim();
}

function installCommand(env: DoctorEnvironment, name: string): string {
  const range = env.sdk.peerDependencies?.[name];
  return range ? `npm install ${name}@${newestAlternative(range)}` : `npm install ${name}`;
}

/** The installed `ai` major when the SDK supports it; else 7, the major the `ai` fix installs. */
function installedAiMajor(env: DoctorEnvironment): AiMajor {
  const major = Number.parseInt(env.resolvePackageVersion('ai') ?? '', 10);
  return major === 4 || major === 6 ? major : 7;
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
  title: string;
  /** What the package enables, appended to the finding (feature peers only). */
  enables?: string;
  /** The `npm install` argument, e.g. `@ai-sdk/openai@^0.0.42`. */
  install: string;
  /** True when the agent spec cannot work without it (not installed becomes a failure). */
  required: boolean;
  /** Provider packages: the versions that pair with the installed `ai` (LOU-D28d), e.g. `ai 7` and `^4.0.0`. */
  pairing?: { ai: string; accepts: string; note?: string };
}

/**
 * The optional peer packages behind the providers, in the version that pairs
 * with the installed `ai` major; required when the spec uses one of its providers.
 */
function providerPeers(env: DoctorEnvironment, needs: SpecNeeds): Map<string, OptionalPeer> {
  const major = installedAiMajor(env);
  const peers = new Map<string, OptionalPeer>();
  for (const info of listProviders()) {
    const { name, range, accepts, note } = info.peers[major];
    peers.set(name, {
      title: `Provider package ${name}`,
      install: `${name}@${range}`,
      required: (peers.get(name)?.required ?? false) || needs.providers.has(info.name),
      pairing: { ai: `ai ${major}`, accepts, note },
    });
  }
  return peers;
}

/** The optional peers behind SDK features (LOU-D40); only Docker can be known from the spec. */
function featurePeers(needs: SpecNeeds): Map<string, OptionalPeer> {
  return new Map(
    Object.entries(FEATURE_PEERS).map(([name, peer]) => [
      name,
      {
        title: `Optional package ${name}`,
        enables: peer.feature,
        install: `${name}@${peer.range}`,
        required: name === 'dockerode' && needs.usesSandbox,
      },
    ])
  );
}

function checkOptionalPeer(env: DoctorEnvironment, name: string, peer: OptionalPeer): DoctorCheck {
  const note = peer.pairing?.note;
  const fix = `npm install ${peer.install}` + (note ? ` (note: ${note})` : '');
  const base = { id: `optional-peer.${name}`, title: peer.title };
  const enables = peer.enables ? ` - enables ${peer.enables}` : '';
  const version = env.resolvePackageVersion(name);
  if (version === null) {
    return {
      ...base,
      status: peer.required ? 'fail' : 'warn',
      finding: peer.required
        ? `not installed, and the agent spec needs it${enables}`
        : `not installed (optional)${enables}`,
      fix,
    };
  }
  const mismatch = versionMismatch(env, name, peer, version);
  if (mismatch) return { ...base, status: peer.required ? 'fail' : 'warn', finding: mismatch + enables, fix };
  return { ...base, status: 'ok', finding: `${version} installed${enables}` };
}

/**
 * Why the installed version is wrong, or null: a provider package must pair with
 * the installed `ai` (LOU-D28d); any other peer must match the SDK's own range.
 */
function versionMismatch(env: DoctorEnvironment, name: string, peer: OptionalPeer, version: string): string | null {
  const expected = peer.pairing
    ? { range: peer.pairing.accepts, by: `${peer.pairing.ai} needs` }
    : { range: env.sdk.peerDependencies?.[name], by: 'the SDK expects' };
  if (!expected.range || satisfiesRange(version, expected.range)) return null;
  return `${version} installed, but ${expected.by} ${expected.range}`;
}

export function checkOptionalPeers(env: DoctorEnvironment, needs: SpecNeeds): DoctorCheck[] {
  return [...providerPeers(env, needs), ...featurePeers(needs)].map(([name, peer]) => checkOptionalPeer(env, name, peer));
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
