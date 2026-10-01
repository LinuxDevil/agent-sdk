/**
 * Internal "<provider>/<model>" resolution shared by `resolveProvider()` and
 * `createAgent()` (LOU-D1). Not re-exported from the providers barrel: the
 * public surface is `resolveProvider()` and `createAgent({ model })`. The
 * `caller` argument only decides the prefix of error messages, so each entry
 * point reports errors in its own name.
 */

import { LLMProvider, LLMProviderConfig, LLMProviderRegistry } from './llm';
import { ConfigurationError } from '../execution/errors';
import { closestMatch } from '../utils/closestMatch';

interface ProviderEntry {
  /** Env var holding the credential (or, for Ollama, the base URL). */
  envKey: string;
  /** LLMProviderConfig field the env var's value belongs in. */
  configField: 'apiKey' | 'baseURL';
  /** Whether the provider cannot work without the env var (Ollama has a local default). */
  envRequired: boolean;
  /** Optional npm peer dependency to install, with the version range the SDK supports. */
  peer: string;
  /** Model used when the provider is picked from the environment alone. */
  envDefaultModel: string;
}

/** What `loushy doctor` needs to know about one provider. */
export interface ProviderInfo {
  name: string;
  envKey: string;
  /** False when the provider has a built-in default (Ollama's local endpoint). */
  envRequired: boolean;
  /** The optional peer package, without a version range. */
  peerPackage: string;
  /** The `npm install` argument for the peer, e.g. `@ai-sdk/openai@^0.0.42`. */
  peerInstall: string;
  /** Model used when the provider is picked from the environment alone. */
  defaultModel: string;
}

/** Every supported provider, in env-detection order. */
export function listProviders(): ProviderInfo[] {
  return Object.entries(PROVIDERS).map(([name, entry]) => ({
    name,
    envKey: entry.envKey,
    envRequired: entry.envRequired,
    peerPackage: peerPackageName(entry.peer),
    peerInstall: entry.peer,
    defaultModel: entry.envDefaultModel,
  }));
}

/**
 * Name of the first provider (in env-detection order) whose env var is set in
 * `env`, or `undefined` when none is. `loushy init --yes` uses it to pick a
 * provider; `LOUSHY_MODEL` is deliberately not consulted.
 */
export function detectProviderFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return Object.entries(PROVIDERS).find(([, entry]) => env[entry.envKey])?.[0];
}

/**
 * The `npm install` command for an optional peer package, with the version
 * range the SDK supports (single source of truth for every install hint).
 * Packages that are not a provider peer get a plain `npm install <name>`.
 */
export function peerInstallCommand(packageName: string): string {
  const entry = Object.values(PROVIDERS).find((e) => peerPackageName(e.peer) === packageName);
  return `npm install ${entry ? entry.peer : packageName}`;
}

/** `@ai-sdk/openai@^0.0.42` -> `@ai-sdk/openai`. */
function peerPackageName(peer: string): string {
  return peer.slice(0, peer.lastIndexOf('@'));
}

/** Providers in env-detection order (see `modelFromEnv()`). */
const PROVIDERS: Record<string, ProviderEntry> = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    configField: 'apiKey',
    envRequired: true,
    peer: '@ai-sdk/openai@^0.0.42',
    envDefaultModel: 'gpt-4o-mini',
  },
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    configField: 'apiKey',
    envRequired: true,
    peer: '@ai-sdk/anthropic@^0.0.42',
    envDefaultModel: 'claude-3-5-sonnet-latest',
  },
  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    configField: 'apiKey',
    envRequired: true,
    peer: '@ai-sdk/openai@^0.0.42',
    envDefaultModel: 'openai/gpt-4o-mini',
  },
  ollama: {
    envKey: 'OLLAMA_BASE_URL',
    configField: 'baseURL',
    envRequired: false,
    peer: 'ollama-ai-provider@^1.2.0',
    envDefaultModel: 'llama3',
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

/** Env var that overrides the automatic provider choice, e.g. `LOUSHY_MODEL=anthropic/claude-3-5-sonnet-latest`. */
const MODEL_ENV_VAR = 'LOUSHY_MODEL';

function unknownProviderError(caller: string, providerName: string, spec: string): Error {
  const suggestion = closestMatch(providerName, PROVIDER_NAMES);
  return new ConfigurationError(
    `${caller}: unrecognized provider '${providerName}' in spec '${spec}'. ` +
      `Supported prefixes: ${PROVIDER_NAMES.join(', ')}.` +
      (suggestion ? ` Did you mean '${suggestion}/${spec.slice(providerName.length + 1)}'?` : ''),
    'model',
    'LOUSHY_PROVIDER_UNKNOWN'
  );
}

function missingKeyError(caller: string, envKey: string): Error {
  return new ConfigurationError(
    `${caller}: ${envKey} is not set. Set it in your environment, ` +
      'or pass a provider instance: createAgent({ provider: ... })',
    envKey,
    'LOUSHY_PROVIDER_MISSING_API_KEY'
  );
}

/** True when `error` says an npm package could not be loaded (CommonJS or ESM resolution). */
function isModuleNotFound(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_MODULE_NOT_FOUND' ||
    (typeof message === 'string' && /cannot find (module|package)/i.test(message))
  );
}

function createProvider(caller: string, providerName: string, entry: ProviderEntry, config: LLMProviderConfig): LLMProvider {
  try {
    return LLMProviderRegistry.create(providerName, config);
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    throw new ConfigurationError(
      `${caller}: the '${providerName}' provider needs an optional peer dependency that is not installed. ` +
        `Run: ${peerInstallCommand(peerPackageName(entry.peer))}`,
      'model',
      'LOUSHY_PEER_MISSING',
      { cause: error }
    );
  }
}

/**
 * Resolve a "<provider>/<model>" spec into a configured LLMProvider, with
 * errors reported in `caller`'s name. See `resolveProvider()`. `extra` is
 * merged into the provider config (createAgent() sets `maxRetries: 0`).
 */
export function resolveProviderSpec(spec: string, caller: string, extra: LLMProviderConfig = {}): LLMProvider {
  const separatorIndex = spec.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === spec.length - 1) {
    throw new ConfigurationError(
      `${caller}: expected a "<provider>/<model>" spec, got '${spec}'. ` +
        `Example: 'openai/gpt-4o-mini'. Supported prefixes: ${PROVIDER_NAMES.join(', ')}.`,
      'model',
      'LOUSHY_PROVIDER_SPEC_INVALID'
    );
  }

  const providerName = spec.slice(0, separatorIndex).toLowerCase();
  const model = spec.slice(separatorIndex + 1);

  const entry = PROVIDERS[providerName];
  if (!entry) throw unknownProviderError(caller, spec.slice(0, separatorIndex), spec);

  const envValue = process.env[entry.envKey];
  if (!envValue && entry.envRequired) throw missingKeyError(caller, entry.envKey);

  return createProvider(caller, providerName, entry, {
    ...extra,
    defaultModel: model,
    [entry.configField]: envValue,
  });
}

/**
 * Pick a "<provider>/<model>" spec from the environment: `LOUSHY_MODEL` if
 * set, otherwise the first provider (in the order openai, anthropic,
 * openrouter, ollama) whose env var is set. Throws, listing every fix, when
 * nothing is configured.
 */
export function modelFromEnv(caller: string, env: Record<string, string | undefined> = process.env): string {
  const explicit = env[MODEL_ENV_VAR];
  if (explicit) return explicit;

  for (const [name, entry] of Object.entries(PROVIDERS)) {
    if (env[entry.envKey]) return `${name}/${entry.envDefaultModel}`;
  }

  const envKeys = Object.values(PROVIDERS).map((p) => p.envKey);
  throw new ConfigurationError(
    `${caller}: no model configured. Do one of the following: ` +
      "(1) pass a model: createAgent({ model: 'openai/gpt-4o-mini' }); " +
      '(2) pass a provider instance: createAgent({ provider: ... }); ' +
      `(3) set ${MODEL_ENV_VAR} (e.g. ${MODEL_ENV_VAR}=openai/gpt-4o-mini); ` +
      `(4) set one of ${envKeys.join(', ')} (checked in that order).`,
    'model',
    'LOUSHY_CONFIG_MISSING_PROVIDER'
  );
}
