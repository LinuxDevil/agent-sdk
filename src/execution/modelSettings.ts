/**
 * C6: an agent's sampling settings (`ModelSettings`), merged and stripped of
 * undefined keys before they are sent, so a key nobody set never overrides
 * what a provider (or a wrapping provider) would apply itself.
 */
import type { ModelSettings } from '../providers/llm';

/** The {@link ModelSettings} keys, in the order they are sent. */
export const MODEL_SETTING_KEYS = [
  'temperature',
  'maxTokens',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'stop',
  'seed',
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
