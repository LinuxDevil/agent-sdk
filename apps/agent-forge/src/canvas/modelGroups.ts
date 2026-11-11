/**
 * `modelGroups` — the catalog→`<Select>` grouping shared by the agent
 * `ModelPicker` and the flow `llmCall` step's model field: one
 * `<optgroup>` per provider, alphabetically; an unavailable model is
 * labelled '(no key)'.
 */
import type { SelectGroup } from '../ui/controls';

/** One `<optgroup>` per provider, alphabetically; an unavailable model is labelled '(no key)'. */
export function modelGroups(models: { id: string; provider: string; available: boolean }[]): SelectGroup[] {
  const providers = [...new Set(models.map((m) => m.provider))].sort();
  return providers.map((provider) => ({
    label: provider,
    options: models
      .filter((m) => m.provider === provider)
      .map((m) => ({ value: m.id, label: m.available ? m.id : `${m.id} (no key)` })),
  }));
}
