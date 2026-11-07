/**
 * `emptyTriggerItem` — the empty `TriggerSpec` a palette entry creates and
 * the Inspector's Type select swaps in. The five PLAN types get the
 * palette table's default fields (an `''` the form then flags required);
 * any other catalog type keeps just `id` and `type` so its schema form
 * fills the rest.
 */
import type { TriggerSpec } from '../../../graph/v2/specTypes';

/** The five PLAN trigger types with a hand-written form, in palette order. */
export const FORM_TRIGGER_TYPES = ['chat', 'cron', 'webhook', 'channel', 'agent'] as const;

/**
 * A fresh `triggers[]` entry of `type` with id `id` — the palette table's
 * `create` values verbatim. A type outside {@link FORM_TRIGGER_TYPES}
 * produces `{ id, type }` only (its Inspector is the schema form).
 */
export function emptyTriggerItem(type: string, id: string): TriggerSpec {
  switch (type) {
    case 'chat':
      return { id, type: 'chat' };
    case 'cron':
      return { id, type: 'cron', cron: '0 9 * * 1-5', prompt: '' };
    case 'webhook':
      return { id, type: 'webhook', path: `/hooks/${id}`, promptTemplate: '' };
    case 'channel':
      return { id, type: 'channel', channel: 'slack', secrets: {} };
    case 'agent':
      return { id, type: 'agent', after: '', on: 'done', promptTemplate: '{{run.resultText}}' };
    default:
      return { id, type } as unknown as TriggerSpec;
  }
}
