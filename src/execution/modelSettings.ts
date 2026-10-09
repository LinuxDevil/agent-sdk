/**
 * C6: an agent's sampling settings (`ModelSettings`), merged and stripped of
 * undefined keys before they are sent, so a key nobody set never overrides
 * what a provider (or a wrapping provider) would apply itself.
 */
import type { ModelSettings } from '../providers/llm';
import { ConfigurationError } from './errors';

/** The {@link ModelSettings} keys, in the order they are sent. */
export const MODEL_SETTING_KEYS = [
  'temperature',
  'maxTokens',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'stop',
  'seed',
  'toolChoice',
] as const satisfies readonly (keyof ModelSettings)[];

/** The settings of `layers` merged, later ones winning key by key; a key that is undefined in every layer is left out. */
export function mergeModelSettings(...layers: (ModelSettings | undefined)[]): ModelSettings {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of MODEL_SETTING_KEYS) {
      if (layer[key] !== undefined) merged[key] = layer[key];
    }
  }
  return merged as ModelSettings;
}

/** Eve CORE-F13: the numeric settings with a bounded range (inclusive), as the major providers accept them. */
const SETTING_RANGES: Readonly<Partial<Record<string, readonly [number, number]>>> = {
  temperature: [0, 2],
  topP: [0, 1],
  frequencyPenalty: [-2, 2],
  presencePenalty: [-2, 2],
};

/** AI SDK (and provider API) names people reach for, mapped to ours. */
const SETTING_SYNONYMS: Readonly<Record<string, keyof ModelSettings>> = {
  maxOutputTokens: 'maxTokens',
  max_tokens: 'maxTokens',
  max_completion_tokens: 'maxTokens',
  top_p: 'topP',
  stopSequences: 'stop',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'presencePenalty',
  tool_choice: 'toolChoice',
};

function describeSetting(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return typeof value === 'string' ? `'${value}'` : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Eve CORE-F13: what is wrong with `value` as the `modelSettings` key `key`,
 * or undefined when nothing is (an undefined value is never sent, so it is fine).
 */
export function modelSettingProblem(key: string, value: unknown): string | undefined {
  if (!(MODEL_SETTING_KEYS as readonly string[]).includes(key)) {
    const meant = SETTING_SYNONYMS[key];
    return `is not a known setting${meant ? ` (did you mean '${meant}'?)` : ''}. Allowed keys: ${MODEL_SETTING_KEYS.join(', ')}`;
  }
  if (value === undefined) return undefined;
  if (key === 'toolChoice') return toolChoiceProblem(value);
  if (key === 'stop') {
    return Array.isArray(value) && value.every((stop) => typeof stop === 'string') ? undefined : `must be an array of strings, got ${describeSetting(value)}`;
  }
  return numericSettingProblem(key, value);
}

/** What is wrong with `value` as `toolChoice`, or undefined when nothing is. */
function toolChoiceProblem(value: unknown): string | undefined {
  const named = isRecord(value) && value.type === 'function' && isRecord(value.function) && typeof value.function.name === 'string';
  return value === 'auto' || value === 'required' || value === 'none' || named
    ? undefined
    : `must be 'auto', 'required', 'none' or { type: 'function', function: { name } }, got ${describeSetting(value)}`;
}

/** What is wrong with `value` as the numeric setting `key`, or undefined when nothing is. */
function numericSettingProblem(key: string, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `must be a number, got ${describeSetting(value)}`;
  if (key === 'maxTokens') return Number.isInteger(value) && value >= 1 ? undefined : `must be a whole number >= 1, got ${value}`;
  if (key === 'seed') return Number.isInteger(value) ? undefined : `must be a whole number, got ${value}`;
  const range = SETTING_RANGES[key];
  return range && (value < range[0] || value > range[1]) ? `must be a number from ${range[0]} to ${range[1]}, got ${value}` : undefined;
}

/**
 * Eve CORE-F13: rejects bad `modelSettings` (`createAgent`'s, or a `send()` /
 * `stream()` call's) with `LOUSHO_CONFIG_INVALID` naming the key, before any
 * model call - instead of a provider round trip whose error names the AI
 * SDK's parameter.
 */
export function assertModelSettings(value: unknown, caller: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new ConfigurationError(`${caller}: 'modelSettings' must be an object like { maxTokens: 1024 }, got ${describeSetting(value)}.`, 'modelSettings');
  }
  for (const [key, entry] of Object.entries(value)) {
    const problem = modelSettingProblem(key, entry);
    if (problem) throw new ConfigurationError(`${caller}: 'modelSettings.${key}' ${problem}.`, `modelSettings.${key}`);
  }
}
