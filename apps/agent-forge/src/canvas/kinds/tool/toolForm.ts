/**
 * The `ToolRef` form helpers the tool card and Inspector share: which of
 * the seven spec variants an `item` is (`toolFormOf`), the chip text each
 * form shows (`TOOL_FORM_CHIP`), whether a form may carry the common
 * `approval`/`deferLoading` keys (`supportsBehaviour`) and the empty item
 * a Type switch writes (`emptyToolItem`).
 */
import type { ToolRef } from '../../../graph/v2/specTypes';

/** The `ToolRef` variant key the Inspector's Type select edits. */
export type ToolForm = 'builtin' | 'registry' | 'file' | 'integration' | 'openapi' | 'hosted' | 'hub';

/** The `ToolRef` union member of one form (narrowed by its kind key). */
export type FormItem<F extends ToolForm> = Extract<ToolRef, { [K in F]: unknown }>;

/** Which `ToolRef` variant `item` is — exactly one kind key per the spec; `hub` is the fallback for a malformed item. */
export function toolFormOf(item: ToolRef): ToolForm {
  if ('builtin' in item) return 'builtin';
  if ('registry' in item) return 'registry';
  if ('file' in item) return 'file';
  if ('integration' in item) return 'integration';
  if ('openapi' in item) return 'openapi';
  if ('hosted' in item) return 'hosted';
  return 'hub';
}

/** The card chip text of each form. */
export const TOOL_FORM_CHIP: Record<ToolForm, string> = {
  builtin: 'built-in',
  registry: 'registry',
  file: 'file',
  integration: 'integration',
  openapi: 'openapi',
  hosted: 'hosted',
  hub: 'hub',
};

/**
 * Whether `form`'s ref may carry the common `approval`/`deferLoading`
 * keys — `ToolRefCommon` covers the first five forms; the hosted and hub
 * variants take only `id` (plus `options` on hosted).
 */
export function supportsBehaviour(form: ToolForm): boolean {
  return form !== 'hosted' && form !== 'hub';
}

/**
 * The `JsonField.check` for `options`-style fields: the value must be a
 * JSON object (not a scalar, null or an array).
 */
export function checkJsonObject(value: unknown): string | undefined {
  return value === null || typeof value !== 'object' || Array.isArray(value)
    ? 'Options must be a JSON object'
    : undefined;
}

/**
 * The empty `item` of `form` — what the Type select writes. It keeps
 * `id` always and `approval`/`deferLoading` when the new form carries
 * them (switching to hosted or hub drops them: those refs cannot hold
 * the keys, so keeping them would write a spec the SDK rejects).
 */
export function emptyToolItem(form: ToolForm, item: ToolRef): ToolRef {
  const keep: Record<string, unknown> = {};
  if (item.id !== undefined) keep['id'] = item.id;
  if (supportsBehaviour(form)) {
    const common = item as { approval?: unknown; deferLoading?: unknown };
    if (common.approval !== undefined) keep['approval'] = common.approval;
    if (common.deferLoading !== undefined) keep['deferLoading'] = common.deferLoading;
  }
  switch (form) {
    case 'builtin':
      return { ...keep, builtin: '' } as ToolRef;
    case 'registry':
      return { ...keep, registry: '' } as ToolRef;
    case 'file':
      return { ...keep, file: '' } as ToolRef;
    case 'integration':
      return { ...keep, integration: 'github', credentials: {} } as ToolRef;
    case 'openapi':
      return { ...keep, openapi: { url: '' } } as ToolRef;
    case 'hosted':
      // `'' as never`: the "not picked yet" empty value — the hosted union
      // only takes the three tool names, but an empty value is a reachable
      // state the validator flags with 'Pick a provider-hosted tool'.
      return { ...keep, hosted: '' as never } as ToolRef;
    case 'hub':
      return { ...keep, hub: true } as ToolRef;
  }
}
