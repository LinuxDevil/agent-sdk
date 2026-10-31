/**
 * The temporary v1 bridge between Studio's v1-shaped callers (the canvas,
 * `PUT /agents/:id`, RunManager - all still on AgentSpec v1) and the spec
 * v2 working copy `AgentRepo` stores on disk.
 *
 * `toLegacySpec` is the inverse of the SDK's `upgradeSpec` for the
 * sections v1 can express; v2-only keys (description, skills, memory,
 * subagents, output, ...) have no v1 projection at all and are instead
 * preserved by `mergeLegacySave`, which copies a v1 save's changed areas
 * onto the stored v2 spec and keeps everything else.
 *
 * Deleted once the routes (D06a), RunManager (D12b) and the canvas (C02)
 * speak spec v2 directly.
 */
import { agentSpecV2Schema, upgradeSpec, type AgentSpec, type AgentSpecGuardrail, type AgentSpecPolicy, type AgentSpecV2 } from 'lousho';
import type { SerializedHook } from '../compileHooks';
import { sortKeysDeep } from '../../shared/stableJson';

/** A `spec.tools` entry read as data - the bridge only needs the kind keys it projects or produces. */
interface PendingToolRef {
  builtin?: string;
  registry?: string;
  [key: string]: unknown;
}

/** A `spec.hooks` entry read as data (same `never`-typed pending section). */
interface PendingHook {
  id: string;
  file?: string;
  inline?: { name: string; point: string; code: string; enabled?: boolean };
}

/** The `never`-typed pending sections of a stored spec, read as plain data by the bridge. */
interface PendingSections {
  tools?: PendingToolRef[];
  hooks?: PendingHook[];
  triggers?: { type: string; [key: string]: unknown }[];
  flow?: unknown;
}

/** `instructions` as a v1 `prompt`: a `{ file }` reference becomes a pointer note v1 cannot follow. */
function legacyPrompt(instructions: AgentSpecV2['instructions']): string {
  return typeof instructions === 'string' ? instructions : `(instructions in file ${instructions.file})`;
}

/** `'provider/model'` back to v1's `provider: { type, model }`, split at the first `/`. */
function legacyProvider(model: string): AgentSpec['provider'] {
  const slash = model.indexOf('/');
  if (slash === -1) return { type: model, model };
  return { type: model.slice(0, slash), model: model.slice(slash + 1) };
}

/** The name a v1 `tools` string maps to on a ref: the builtin name, or the registry item's name. */
function toolRefName(ref: PendingToolRef): string | undefined {
  return typeof ref.builtin === 'string' ? ref.builtin : typeof ref.registry === 'string' ? ref.registry : undefined;
}

/**
 * Whether `name` is a builtin the landed `tools` schema knows. Studio-local
 * names (buildAgent.ts's LOCAL_TOOLS, e.g. 'demo-approval') and names the
 * SDK cannot run are not; they store as `{ registry: name }` so the spec
 * still validates and the name round-trips through the v1 facade.
 */
function isBuiltinToolName(name: string): boolean {
  return agentSpecV2Schema.safeParse({
    version: 2,
    name: 'probe',
    model: 'p/m',
    instructions: 'probe',
    tools: [{ builtin: name }],
  }).success;
}

/**
 * The v1 tool name each v2 builtin projects to - the inverse of
 * `upgradeSpec`'s V1_TOOL_NAMES. A builtin with no v1 alias (e.g. `todo`)
 * has no v1 runtime form and drops, like the other non-projectable kinds.
 */
const V1_BUILTIN_NAMES: Readonly<Record<string, string>> = {
  http_request: 'http',
  current_date: 'current-date',
  day_name: 'day-name',
  web_fetch: 'web-fetch',
};

/**
 * v2 tool refs back to v1 `tools: string[]` - a `{ builtin }` projects to its
 * v1 alias (or drops when v1 has no name for it), a `{ registry }` projects
 * to its item name (a Studio-local tool round-trips, and `lousho build`
 * sees the same string a v1 spec would have held); other kinds are dropped.
 */
function legacyTools(tools: PendingToolRef[] | undefined): string[] | undefined {
  const names = (tools ?? []).flatMap((ref) => {
    if (typeof ref.builtin === 'string') {
      const v1 = V1_BUILTIN_NAMES[ref.builtin];
      return v1 === undefined ? [] : [v1];
    }
    return typeof ref.registry === 'string' ? [ref.registry] : [];
  });
  return names.length > 0 ? names : undefined;
}

/**
 * v2 `permissions` back to v1 `policy.requiresApproval` - only `ask` rules
 * project: `true` when a rule asks on `'*'`, else the flattened tool list,
 * or omitted when there is nothing to ask about.
 */
function legacyRequiresApproval(permissions: AgentSpecV2['permissions']): boolean | string[] | undefined {
  const asks = (permissions ?? []).filter((rule) => rule.action === 'ask');
  if (asks.length === 0) return undefined;
  if (asks.some((rule) => rule.tool === '*')) return true;
  return asks.flatMap((rule) => (Array.isArray(rule.tool) ? rule.tool : [rule.tool]));
}

/** One v2 `guardrails` entry as v1's `{ name, on?, ...options }` guardrail form. */
function legacyGuardrail(entry: NonNullable<AgentSpecV2['guardrails']>[number]): AgentSpecGuardrail {
  const on = entry.on;
  return {
    name: entry.name,
    ...(on !== undefined && { on: (on as unknown) === 'both' ? ['input', 'output'] : on }),
    ...(entry.options ?? {}),
  };
}

/**
 * v2 inline hooks back to v1 `policy.hooks` `SerializedHook`s - enabled
 * inline hooks only (file hooks and `enabled: false` have no v1 runtime
 * form). `nodeKey` mirrors the hook id: the v1 canvas's node-attachment
 * key has no v2 counterpart, so the id is the stable thing to carry.
 */
function legacyHooks(hooks: PendingHook[] | undefined): SerializedHook[] | undefined {
  const serialized: SerializedHook[] = (hooks ?? [])
    .filter(
      (hook): hook is PendingHook & { inline: NonNullable<PendingHook['inline']> } =>
        hook.inline !== undefined && hook.inline.enabled !== false
    )
    .map((hook) => ({
      nodeKey: hook.id,
      id: hook.id,
      name: hook.inline.name,
      phase: hook.inline.point.startsWith('pre') ? 'pre' : 'post',
      point: hook.inline.point.endsWith('ToolCall') ? 'toolCall' : 'generate',
      code: hook.inline.code,
    }));
  return serialized.length > 0 ? serialized : undefined;
}

/** The v1 `policy` object a v2 spec projects to, or `undefined` when no v1-visible key remains. */
function legacyPolicy(spec: AgentSpecV2, pending: PendingSections): AgentSpecPolicy | undefined {
  const requiresApproval = legacyRequiresApproval(spec.permissions);
  const guardrails = (spec.guardrails ?? []).map(legacyGuardrail);
  const hooks = legacyHooks(pending.hooks);
  const policy: AgentSpecPolicy = {
    ...(requiresApproval !== undefined && { requiresApproval }),
    ...(guardrails.length > 0 && { guardrails }),
    ...(spec.limits !== undefined && { limits: spec.limits }),
    ...(spec.askQuestion !== undefined && { askQuestion: spec.askQuestion }),
    ...(spec.compaction !== undefined && { compaction: spec.compaction }),
    ...(hooks !== undefined && { hooks }),
    ...(pending.flow !== undefined && { flow: pending.flow }),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * A stored v2 spec as the AgentSpec v1 the canvas and routes still speak.
 * The inverse of `upgradeSpec` for the keys v1 can express - v2-only keys
 * simply do not appear here.
 */
export function toLegacySpec(spec: AgentSpecV2): AgentSpec {
  const pending = spec as unknown as PendingSections;
  const legacy: AgentSpec = {
    name: spec.name,
    prompt: legacyPrompt(spec.instructions),
    provider: legacyProvider(spec.model),
  };
  const tools = legacyTools(pending.tools);
  if (tools !== undefined) legacy.tools = tools;
  const policy = legacyPolicy(spec, pending);
  if (policy !== undefined) legacy.policy = policy;
  if (pending.triggers !== undefined && pending.triggers.length > 0) {
    legacy.triggers = pending.triggers;
  }
  if (spec.mcpServers !== undefined) {
    legacy.mcpServers = spec.mcpServers as AgentSpec['mcpServers'];
  }
  return legacy;
}

/** Deep-equal on spec data: JSON of the deep key-sorted value, `undefined` normalized to null. */
function sameSpecData(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a ?? null)) === JSON.stringify(sortKeysDeep(b ?? null));
}

/** Sets `target[key]` to `value`, or deletes it when `value` is undefined (a v1 save can clear a whole section). */
function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

/**
 * The merged `tools` of a v1 save: stored refs a v1 name still matches come
 * first and survive untouched; each upgraded `{ builtin }` the save asked
 * for then reuses the matching stored non-builtin ref when there is one,
 * stays `{ builtin }` when the name is a real builtin, and otherwise stores
 * as `{ registry: name }` - the only valid ref shape for a Studio-local
 * tool name the SDK's builtin catalog does not know.
 */
function mergedTools(stored: AgentSpecV2, up: AgentSpecV2): PendingToolRef[] | undefined {
  const storedTools = (stored as unknown as PendingSections).tools ?? [];
  const upTools = (up as unknown as PendingSections).tools ?? [];
  const nonBuiltinStored = storedTools.filter((ref) => typeof ref.builtin !== 'string');
  const storedByName = new Map(
    nonBuiltinStored.flatMap((ref) => {
      const name = toolRefName(ref);
      return name === undefined ? [] : [[name, ref] as const];
    })
  );
  const reused = new Set<PendingToolRef>();
  const upgraded = upTools.map((ref) => {
    if (typeof ref.builtin !== 'string') return ref;
    const storedRef = storedByName.get(ref.builtin);
    if (storedRef !== undefined) {
      reused.add(storedRef);
      return storedRef;
    }
    return isBuiltinToolName(ref.builtin) ? ref : { registry: ref.builtin };
  });
  const merged = [...nonBuiltinStored.filter((ref) => !reused.has(ref)), ...upgraded];
  return merged.length > 0 ? merged : undefined;
}

/** The v1 `policy` sub-keys that map onto v2 spec keys, in `upgradeSpec`'s order. */
const POLICY_AREA_KEYS = [
  ['requiresApproval', 'permissions'],
  ['guardrails', 'guardrails'],
  ['limits', 'limits'],
  ['askQuestion', 'askQuestion'],
  ['compaction', 'compaction'],
  ['hooks', 'hooks'],
  ['flow', 'flow'],
] as const;

/** Copies each changed v1 policy sub-key's v2 counterpart from `up` onto `merged` (or clears it). */
function mergePolicyAreas(merged: Record<string, unknown>, legacy: AgentSpec, before: AgentSpec, up: AgentSpecV2): void {
  const upRecord = up as unknown as Record<string, unknown>;
  for (const [v1Key, v2Key] of POLICY_AREA_KEYS) {
    if (sameSpecData(legacy.policy?.[v1Key], before.policy?.[v1Key])) continue;
    setOrDelete(merged, v2Key, upRecord[v2Key]);
  }
}

/**
 * The v2 spec to store for a v1 `save`: `stored` is the source of truth for
 * every v2-only key; each v1 area that differs from `toLegacySpec(stored)`
 * is replaced by its counterpart from `upgradeSpec(legacy)`. With no stored
 * spec the save is a plain upgrade.
 */
export function mergeLegacySave(stored: AgentSpecV2 | undefined, legacy: AgentSpec): AgentSpecV2 {
  const up = upgradeSpec(legacy);
  if (stored === undefined) {
    // A first save is the plain upgrade - except `tools`, where a name the
    // builtin catalog does not know stores as a `{ registry }` ref instead.
    const fresh = { ...(up as unknown as Record<string, unknown>) };
    setOrDelete(fresh, 'tools', mergedTools(up, up));
    return fresh as unknown as AgentSpecV2;
  }
  const before = toLegacySpec(stored);
  const merged: Record<string, unknown> = { ...stored };

  if (!sameSpecData(legacy.name, before.name)) merged['name'] = up.name;
  if (!sameSpecData(legacy.prompt, before.prompt)) merged['instructions'] = up.instructions;
  if (!sameSpecData(legacy.provider, before.provider)) merged['model'] = up.model;
  if (!sameSpecData(legacy.tools, before.tools)) setOrDelete(merged, 'tools', mergedTools(stored, up));
  if (!sameSpecData(legacy.triggers, before.triggers)) {
    setOrDelete(merged, 'triggers', (up as unknown as PendingSections).triggers);
  }
  if (!sameSpecData(legacy.mcpServers, before.mcpServers)) {
    setOrDelete(merged, 'mcpServers', up.mcpServers);
  }
  mergePolicyAreas(merged, legacy, before, up);
  return merged as unknown as AgentSpecV2;
}
