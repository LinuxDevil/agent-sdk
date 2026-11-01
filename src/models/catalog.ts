/**
 * The model catalog (`listModels()`): every registered model with the
 * capability flags a model picker shows (tools, vision, reasoning,
 * structured output, hosted tool types) and whether its provider's API key
 * is set.
 *
 * Capability values are a hand-maintained snapshot, like `modelData.ts`
 * (retrieved 2026-10-29; hosted tools from each provider's
 * `supportsHostedTool`): ids not in `MODEL_OVERRIDES` fall back to their
 * provider's defaults, providers not in the table fall back to `FALLBACK`,
 * and `reasoning` uses {@link supportsReasoning}, the same family test the
 * SDK applies before sending reasoning options. Browser-safe: no `node:*`
 * imports, so the Studio SPA can use it too.
 */

import { listProviders, type ProviderInfo } from '../providers/providerSpec';
import { supportsReasoning } from '../providers/reasoning';
import { listRegisteredModels, type ModelInfo } from './registry';

/** What a model can do, as the catalog reports it. */
export interface ModelCapabilities {
  /** Accepts tool definitions and returns tool calls. */
  tools: boolean;
  /** Accepts image input. */
  vision: boolean;
  /** Is in a family known to accept `reasoning` options (see {@link supportsReasoning}). */
  reasoning: boolean;
  /** Honours a structured-output schema (`output` / response format). */
  structuredOutput: boolean;
  /** Hosted tool types the provider runs (`'web_search'`, `'code_interpreter'`, `'file_search'`). */
  hostedTools: string[];
}

/** A model picker row. `id` is `'provider/model'` (the spec's `model` value); `modelId` is the bare id. */
export interface ModelCatalogEntry extends Omit<ModelInfo, 'id'> {
  /** `'provider/model'`, as `createAgent({ model })` and the spec take it. */
  id: string;
  /** The bare model id the provider is called with. */
  modelId: string;
  /** What the model can do (tools, vision, reasoning, structured output, hosted tools) - the picker's capability column. */
  capabilities: ModelCapabilities;
  /** The provider's env key is set (or the provider needs none, like ollama). */
  available: boolean;
}

/** Options for {@link listModels}. */
export interface ListModelsOptions {
  /** Only list this provider's models. */
  provider?: string;
  /** Environment to check keys in. Default `globalThis.process?.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Hosted tool types each provider's `supportsHostedTool` accepts. */
const HOSTED_TOOLS_BY_PROVIDER: Record<string, string[]> = {
  openai: ['web_search', 'code_interpreter', 'file_search'],
  anthropic: ['web_search', 'code_interpreter'],
  openrouter: ['web_search'],
  google: [],
  ollama: [],
};

/** Per-provider defaults for tools / vision / structuredOutput. */
const PROVIDER_DEFAULTS: Record<string, Pick<ModelCapabilities, 'tools' | 'vision' | 'structuredOutput'>> = {
  openai: { tools: true, vision: true, structuredOutput: true },
  anthropic: { tools: true, vision: true, structuredOutput: true },
  openrouter: { tools: true, vision: false, structuredOutput: true },
  google: { tools: true, vision: true, structuredOutput: true },
  ollama: { tools: true, vision: false, structuredOutput: true },
};

/** Built-in models that differ from their provider's default. */
const MODEL_OVERRIDES: Record<string, Partial<ModelCapabilities>> = {
  'gpt-3.5-turbo': { vision: false },
  'gpt-4-turbo': { structuredOutput: false },
  'gpt-4o-2024-05-13': { structuredOutput: false },
  'o3-mini': { vision: false },
  llama3: { tools: false },
};

/** Capability defaults for a provider not in the table (a registered custom provider). */
const FALLBACK = { tools: true, vision: false, structuredOutput: false };

/** The capabilities of `info`: provider defaults, then the model's overrides, then reasoning and hosted tools. */
function capabilitiesOf(info: ModelInfo): ModelCapabilities {
  return {
    ...(PROVIDER_DEFAULTS[info.provider] ?? FALLBACK),
    ...(MODEL_OVERRIDES[info.id] ?? {}),
    reasoning: supportsReasoning(info.provider, info.id),
    hostedTools: [...(HOSTED_TOOLS_BY_PROVIDER[info.provider] ?? [])],
  };
}

/** The process env when there is one (absent in browsers/Workers), else an empty map. */
function processEnv(): Readonly<Record<string, string | undefined>> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

/**
 * Every registered model with its capabilities and availability, sorted by
 * provider then id. `available` only means the provider's env key is set in
 * `options.env` (or the provider needs none) — the key is not probed.
 *
 * @example
 * listModels({ provider: 'anthropic' }).filter((m) => m.available);
 */
export function listModels(options: ListModelsOptions = {}): ModelCatalogEntry[] {
  const env = options.env ?? processEnv();
  const providers = new Map(listProviders().map((info: ProviderInfo) => [info.name, info]));
  return listRegisteredModels()
    .filter((info) => options.provider === undefined || info.provider === options.provider)
    .map((info) => ({
      ...info,
      id: `${info.provider}/${info.id}`,
      modelId: info.id,
      capabilities: capabilitiesOf(info),
      available: isAvailable(info.provider, providers, env),
    }))
    .sort(byProviderThenId);
}

/** `a < b` / `a > b` as -1 / 0 / 1: code-point order, so the sort does not depend on the locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Catalog order: provider asc, then model id asc. */
function byProviderThenId(a: ModelCatalogEntry, b: ModelCatalogEntry): number {
  return cmp(a.provider, b.provider) || cmp(a.modelId, b.modelId);
}

/** Whether `provider` is a listed provider whose required env key is set. */
function isAvailable(
  provider: string,
  providers: Map<string, ProviderInfo>,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const entry = providers.get(provider);
  return entry !== undefined && (!entry.envRequired || Boolean(env[entry.envKey]));
}
