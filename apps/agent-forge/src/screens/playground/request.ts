/** Pure helpers that turn the Playground's editor state into a `POST /playground/run` body. */
import type { ProviderKeyStatus } from '../../../shared/wireTypes';
import { detectVariables } from './variables';
import type { PlaygroundMessage, PlaygroundRunBody } from './types';

/** The run without a provider key: the Studio's mock model. */
export const MOCK_PROVIDER = 'mock';
/** Local Ollama needs no key, so it is always offered. */
const KEYLESS_PROVIDERS = ['ollama', MOCK_PROVIDER];

/** The provider select's options: providers with a stored key, then the keyless ones. */
export function providerOptions(keys: readonly ProviderKeyStatus[]): string[] {
  return [...keys.filter((k) => k.hasKey).map((k) => k.provider), ...KEYLESS_PROVIDERS];
}

/** The first provider with a key, else `mock`. */
export function defaultProvider(keys: readonly ProviderKeyStatus[]): string {
  return keys.find((k) => k.hasKey)?.provider ?? MOCK_PROVIDER;
}

/** The `model` field: `mock`, `provider/model`, a bare provider when no model is typed, or the typed string for a custom (`''`) provider. */
export function modelString(provider: string, model: string): string {
  const name = model.trim();
  if (provider === MOCK_PROVIDER) return MOCK_PROVIDER;
  if (provider === '') return name || MOCK_PROVIDER;
  return name ? `${provider}/${name}` : provider;
}

/** What the screen hands {@link buildRunBody}. */
export interface RunInput {
  messages: readonly PlaygroundMessage[];
  values: Readonly<Record<string, string>>;
  model: string;
  tools: readonly string[];
  promptRef?: string;
}

/** The request body: empty rows dropped, only the detected variables sent; `undefined` when no row has content. */
export function buildRunBody(input: RunInput): PlaygroundRunBody | undefined {
  const messages = input.messages.filter((m) => m.content.trim() !== '');
  if (messages.length === 0) return undefined;
  const names = detectVariables(messages);
  const variables = Object.fromEntries(names.map((name) => [name, input.values[name] ?? '']));
  return {
    messages,
    model: input.model,
    ...(names.length ? { variables } : {}),
    ...(input.tools.length ? { tools: [...input.tools] } : {}),
    ...(input.promptRef ? { promptRef: input.promptRef } : {}),
  };
}
