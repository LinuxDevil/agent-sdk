/**
 * Internal "<provider>/<model>" resolution shared by `resolveProvider()` and
 * `createAgent()` (LOU-D1). Not re-exported from the providers barrel: the
 * public surface is `resolveProvider()` and `createAgent({ model })`. The
 * `caller` argument only decides the prefix of error messages, so each entry
 * point reports errors in its own name.
 */

import { LLMProvider, LLMProviderConfig, LLMProviderRegistry } from './llm';

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
}

/** Every supported provider, in env-detection order. */
export function listProviders(): ProviderInfo[] {
  return Object.entries(PROVIDERS).map(([name, entry]) => ({
    name,
    envKey: entry.envKey,
    envRequired: entry.envRequired,
    peerPackage: entry.peer.slice(0, entry.peer.lastIndexOf('@')),
    peerInstall: entry.peer,
  }));
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

/** Levenshtein edit distance between two short strings. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/** The supported provider prefix closest to `name`, if it is plausibly a typo of one. */
function closestProvider(name: string): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of PROVIDER_NAMES) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(lower.length / 3)) ? best : undefined;
}

function unknownProviderError(caller: string, providerName: string, spec: string): Error {
  const suggestion = closestProvider(providerName);
  return new Error(
    `${caller}: unrecognized provider '${providerName}' in spec '${spec}'. ` +
      `Supported prefixes: ${PROVIDER_NAMES.join(', ')}.` +
      (suggestion ? ` Did you mean '${suggestion}/${spec.slice(providerName.length + 1)}'?` : '')
  );
}

function missingKeyError(caller: string, envKey: string): Error {
  return new Error(
    `${caller}: ${envKey} is not set. Set it in your environment, ` +
      'or pass a provider instance: createAgent({ provider: ... })'
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
    throw new Error(
      `${caller}: the '${providerName}' provider needs an optional peer dependency that is not installed. ` +
        `Run: npm install ${entry.peer}`,
      { cause: error }
    );
  }
}

/**
 * Resolve a "<provider>/<model>" spec into a configured LLMProvider, with
 * errors reported in `caller`'s name. See `resolveProvider()`.
 */
export function resolveProviderSpec(spec: string, caller: string): LLMProvider {
  const separatorIndex = spec.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === spec.length - 1) {
    throw new Error(
      `${caller}: expected a "<provider>/<model>" spec, got '${spec}'. ` +
        `Example: 'openai/gpt-4o-mini'. Supported prefixes: ${PROVIDER_NAMES.join(', ')}.`
    );
  }

  const providerName = spec.slice(0, separatorIndex).toLowerCase();
  const model = spec.slice(separatorIndex + 1);

  const entry = PROVIDERS[providerName];
  if (!entry) throw unknownProviderError(caller, spec.slice(0, separatorIndex), spec);

  const envValue = process.env[entry.envKey];
  if (!envValue && entry.envRequired) throw missingKeyError(caller, entry.envKey);

  return createProvider(caller, providerName, entry, {
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
  throw new Error(
    `${caller}: no model configured. Do one of the following: ` +
      "(1) pass a model: createAgent({ model: 'openai/gpt-4o-mini' }); " +
      '(2) pass a provider instance: createAgent({ provider: ... }); ' +
      `(3) set ${MODEL_ENV_VAR} (e.g. ${MODEL_ENV_VAR}=openai/gpt-4o-mini); ` +
      `(4) set one of ${envKeys.join(', ')} (checked in that order).`
  );
}
