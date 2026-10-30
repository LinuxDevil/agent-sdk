/**
 * upgradeSpec(): any valid v1 AgentSpec (including the `policy.hooks` /
 * `policy.flow` keys Studio writes) as AgentSpecV2 data, plus the v1 spec
 * tool name → v2 builtin name map. Browser-safe: no `node:*` imports.
 */
import { ValidationError } from '../../execution/errors';
import type { RunLimits } from '../../execution/budget';
import { issueMessage, issuePath } from '../../utils/zodCompat';
import { guardrailParts } from '../guardrailOptions';
import { agentSpecSchema, type AgentSpec, type AgentSpecPolicy, type AgentSpecTrigger, type McpServerSpec } from '../schema';
import type { AgentSpecV2, AgentSpecV2Compaction } from './types';

/** v1 spec tool names → v2 builtin names (model-facing). Unknown names pass through unchanged. */
export const V1_TOOL_NAMES: Readonly<Record<string, string>> = {
  http: 'http_request',
  'current-date': 'current_date',
  'day-name': 'day_name',
  'web-fetch': 'web_fetch',
};

/** Studio's `policy.hooks` phase/point pair → the v2 inline hook point name. */
const POINTS = {
  pre: { toolCall: 'preToolCall', generate: 'preGenerate' },
  post: { toolCall: 'postToolCall', generate: 'postGenerate' },
} as const;

type InlineHookPoint = (typeof POINTS)[keyof typeof POINTS]['toolCall' | 'generate'];

/**
 * The v2 object upgradeSpec builds: landed fields typed, pending sections
 * (`tools`, `guardrails`, `permissions`, `hooks`, `triggers`, `flow`) as the
 * data shapes the section tickets' schemas will validate.
 */
interface UpgradedSpec {
  version: 2;
  name: string;
  model: string;
  instructions: string;
  tools?: { builtin: string }[];
  mcpServers?: Record<string, McpServerSpec>;
  guardrails?: { id: string; name: string; on?: unknown; options?: Record<string, unknown> }[];
  permissions?: { id: string; tool: string | string[]; action: 'ask' }[];
  hooks?: { id: string; inline: { name: string; point: InlineHookPoint; code: string } }[];
  limits?: RunLimits;
  askQuestion?: boolean;
  compaction?: boolean | AgentSpecV2Compaction;
  triggers?: Record<string, unknown>[];
  flow?: unknown;
}

/** One serialized Studio hook (apps/agent-forge `SerializedHook`), loosely typed: `nodeKey` and extras are ignored. */
interface SerializedHookLike {
  id: string;
  name: string;
  phase: keyof typeof POINTS;
  point: 'toolCall' | 'generate';
  code: string;
}

/** Whether `value` is spec data whose `version` field already says v2. */
function isV2Spec(input: unknown): input is AgentSpecV2 {
  return typeof input === 'object' && input !== null && (input as { version?: unknown }).version === 2;
}

/** Validates `input` as a v1 AgentSpec; a failure throws LOUSHO_SPEC_INVALID with v1's `'path': message` details. */
function parseV1(input: unknown): AgentSpec {
  const result = agentSpecSchema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `'${issuePath(issue)}': ${issueMessage(issue).replace(/^AgentSpec validation failed: /, '')}`)
    .join('; ');
  throw new ValidationError(`upgradeSpec: not a valid v1 AgentSpec - ${details}`, undefined, 'LOUSHO_SPEC_INVALID');
}

/** v1 `tools` names → v2 `{ builtin }` refs (omitted when absent or empty). */
function toolsOf(spec: AgentSpec): Pick<UpgradedSpec, 'tools'> {
  if (spec.tools === undefined || spec.tools.length === 0) return {};
  return { tools: spec.tools.map((name) => ({ builtin: V1_TOOL_NAMES[name] ?? name })) };
}

/** `policy.requiresApproval` → one 'ask' permission rule (omitted for false/[]). */
function permissionsOf(policy: AgentSpecPolicy): Pick<UpgradedSpec, 'permissions'> {
  const required = policy.requiresApproval;
  if (required === true) return { permissions: [{ id: 'p1', tool: '*', action: 'ask' }] };
  if (Array.isArray(required) && required.length > 0) {
    return { permissions: [{ id: 'p1', tool: required.map((name) => V1_TOOL_NAMES[name] ?? name), action: 'ask' }] };
  }
  return {};
}

/** `policy.guardrails` → `guardrails` with g1... ids; `on` leaves `options` for its own key. */
function guardrailsOf(policy: AgentSpecPolicy): Pick<UpgradedSpec, 'guardrails'> {
  const entries = policy.guardrails;
  if (entries === undefined || entries.length === 0) return {};
  return {
    guardrails: entries.map((entry, index) => {
      const { name, options } = guardrailParts(entry);
      const { on, ...rest } = options;
      return {
        id: `g${index + 1}`,
        name,
        ...(on !== undefined && { on }),
        ...(Object.keys(rest).length > 0 && { options: rest }),
      };
    }),
  };
}

/** Whether `value` has the serialized-hook keys Studio writes under `policy.hooks` (`nodeKey` allowed, ignored). */
function isSerializedHook(value: unknown): value is SerializedHookLike {
  if (typeof value !== 'object' || value === null) return false;
  const hook = value as Record<string, unknown>;
  return (
    typeof hook.id === 'string' &&
    typeof hook.name === 'string' &&
    typeof hook.code === 'string' &&
    (hook.phase === 'pre' || hook.phase === 'post') &&
    (hook.point === 'toolCall' || hook.point === 'generate')
  );
}

/** `policy.hooks` → inline hooks at the v2 point names; anything else throws LOUSHO_SPEC_INVALID. */
function hooksOf(policy: AgentSpecPolicy): Pick<UpgradedSpec, 'hooks'> {
  const hooks = policy.hooks;
  if (hooks === undefined) return {};
  if (!Array.isArray(hooks) || !hooks.every(isSerializedHook)) {
    throw new ValidationError(
      'upgradeSpec: policy.hooks must be a list of { id, name, phase, point, code }',
      undefined,
      'LOUSHO_SPEC_INVALID'
    );
  }
  if (hooks.length === 0) return {};
  return {
    hooks: hooks.map((hook) => ({
      id: hook.id,
      inline: { name: hook.name, point: POINTS[hook.phase][hook.point], code: hook.code },
    })),
  };
}

/** `policy.limits` / `askQuestion` / `compaction`, kept under the same names at the top level. */
function policyScalars(policy: AgentSpecPolicy): Pick<UpgradedSpec, 'limits' | 'askQuestion' | 'compaction'> {
  return {
    ...(policy.limits !== undefined && { limits: policy.limits }),
    ...(policy.askQuestion !== undefined && { askQuestion: policy.askQuestion }),
    ...(policy.compaction !== undefined && { compaction: policy.compaction }),
  };
}

/** One trigger with its t<N> id; a cron `input` becomes `prompt` unless the trigger already has one. */
function upgradeTrigger(trigger: AgentSpecTrigger, index: number): Record<string, unknown> {
  const { input, ...rest } = trigger;
  const renamed = input === undefined ? {} : rest.type === 'cron' && rest.prompt === undefined ? { prompt: input } : { input };
  return { id: `t${index + 1}`, ...rest, ...renamed };
}

/** `triggers` with t1... ids (omitted when absent or empty). */
function triggersOf(spec: AgentSpec): Pick<UpgradedSpec, 'triggers'> {
  if (spec.triggers === undefined || spec.triggers.length === 0) return {};
  return { triggers: spec.triggers.map(upgradeTrigger) };
}

/**
 * A v1 AgentSpec (or already-v2 data) as AgentSpecV2. v1 input is first
 * validated with v1's `agentSpecSchema` (throws ValidationError
 * LOUSHO_SPEC_INVALID with v1's messages). Input with `version: 2` is
 * returned as is. The result is NOT validated against v2 (callers use
 * `parseAgentSpecV2` / `loadSpecV2`). Harness-specific `policy` keys other
 * than the mapped ones are dropped.
 */
export function upgradeSpec(input: unknown): AgentSpecV2 {
  if (isV2Spec(input)) return input;
  const spec = parseV1(input);
  const policy = spec.policy ?? {};
  const upgraded: UpgradedSpec = {
    version: 2,
    name: spec.name,
    model: `${spec.provider.type}/${spec.provider.model}`,
    instructions: spec.prompt,
    ...toolsOf(spec),
    ...(spec.mcpServers !== undefined && { mcpServers: spec.mcpServers }),
    ...guardrailsOf(policy),
    ...permissionsOf(policy),
    ...hooksOf(policy),
    ...policyScalars(policy),
    ...triggersOf(spec),
    ...(policy.flow !== undefined && { flow: policy.flow }),
  };
  return upgraded as AgentSpecV2;
}
