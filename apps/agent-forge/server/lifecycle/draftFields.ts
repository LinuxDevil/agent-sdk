/**
 * Draft field classification (L11a): every `SpecChange` a draft produces
 * lands in `routine` or `gated`. Routine edits are the ones a reviewer
 * can skim; gated edits always need the user's explicit click - the
 * table fails closed, so a spec key nobody classified is gated.
 *
 * The class table is data on purpose: a new spec field falls into the
 * "other → gated" row automatically instead of needing a code change.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../../shared/stableJson';
import type { ChangeDraft, DraftFieldClasses, SpecChange } from '../../shared/wireTypes';

export type FieldClass = 'routine' | 'gated';

/** Plain top-level keys whose every change is routine. */
const ROUTINE_KEYS: ReadonlySet<string> = new Set([
  'instructions',
  'instructionsByFamily',
  'description',
  'labels',
  'skills',
]);

/**
 * The gated plain keys (`model`, `fallbackModels`, `mcpServers`,
 * `permissions`, `permissionMode`, `triggers`, `abortListeners`, `hooks`,
 * `subagents`, `handoffs`) need no table entry: anything not routine is
 * gated, which is also the fail-closed row for `name`, `limits`,
 * `output`, `flow` and every future spec key.
 */

/** The change's top-level spec key: 'tools[web-fetch]' and 'memory[0].x' both reduce to their field. */
function topKey(field: string): string {
  return field.split(/[.[\]]/)[0];
}

/**
 * The item keys of a keyed-list `edit` whose values differ between
 * `before` and `after` (top-level properties only - deep paths under a
 * changed property still count as that property changing).
 */
function changedItemKeys(before: unknown, after: unknown): string[] {
  const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
  return [...keys].filter(
    (key) => stableStringify((before as Record<string, unknown>)[key]) !== stableStringify((after as Record<string, unknown>)[key])
  );
}

/**
 * Whether every changed path of a `memory[…]` item edit sits under
 * `recall` (`memory[x].recall.limit` is routine; `memory[x].provider`
 * or a `name`/`scope` change is gated). Non-object sides fail closed.
 */
function memoryEditIsRecallOnly(change: SpecChange): boolean {
  if (change.op !== 'edit' || typeof change.before !== 'object' || change.before === null) return false;
  if (typeof change.after !== 'object' || change.after === null) return false;
  const changed = changedItemKeys(change.before, change.after);
  return changed.length > 0 && changed.every((key) => key === 'recall');
}

/**
 * One change's class. `field` may be a plain key ('model') or a keyed
 * item ('tools[web-fetch]', 'memory[facts]'); `op` disambiguates the
 * keyed cases the table calls out (tool removes and guardrail adds are
 * routine, the reverse directions gated).
 */
export function classifyChange(change: SpecChange): FieldClass {
  const key = topKey(change.field);
  if (ROUTINE_KEYS.has(key)) return 'routine';
  if (key === 'memory') return memoryEditIsRecallOnly(change) ? 'routine' : 'gated';
  if (key === 'tools') return change.op === 'remove' ? 'routine' : 'gated';
  if (key === 'guardrails') return change.op === 'add' ? 'routine' : 'gated';
  // GATED_KEYS and everything else: fail closed.
  return 'gated';
}

/**
 * The draft's changed `SpecChange.field` paths split by class, each
 * listed once per class (a field can appear in both when different
 * items of it classify differently, e.g. one memory slot's recall and
 * another's provider).
 */
export function classifyDraft(changes: SpecChange[]): DraftFieldClasses {
  const routine = new Set<string>();
  const gated = new Set<string>();
  for (const change of changes) {
    (classifyChange(change) === 'routine' ? routine : gated).add(change.field);
  }
  return { routine: [...routine], gated: [...gated] };
}

/**
 * sha256 hex of the stable-JSON `{ patch, reason, baseVersion }` - the
 * value the review verdict binds to, so a restated draft (new reason or
 * patch) never inherits the old verdict.
 */
export function draftFingerprint(draft: Pick<ChangeDraft, 'patch' | 'reason' | 'baseVersion'>): string {
  return createHash('sha256')
    .update(stableStringify({ patch: draft.patch, reason: draft.reason, baseVersion: draft.baseVersion }))
    .digest('hex');
}
