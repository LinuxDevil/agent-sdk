/**
 * The Overview tab's pure view model (A06): turns the spec v2 sections and
 * the record's readiness rows into the rows the cards render. Every helper
 * treats an absent spec key as empty, so a minimal spec still draws all six
 * capability rows and the safety rows.
 */
import { Clock, MessageSquare, Radio, Webhook, Workflow, type LucideIcon } from 'lucide-react';
import type { AgentSpecV2 } from 'lousho/spec';

import type { Requirement } from '../../../shared/wireTypes';

/** One `spec.tools` entry, narrowed off the spec so callers never import the SDK's section types. */
type ToolRef = NonNullable<AgentSpecV2['tools']>[number];
/** One `spec.skills` entry. */
type SkillRef = NonNullable<AgentSpecV2['skills']>[number];
/** One `spec.triggers` entry. */
type TriggerSpec = NonNullable<AgentSpecV2['triggers']>[number];
/** One `spec.guardrails` entry. */
type GuardrailSpec = NonNullable<AgentSpecV2['guardrails']>[number];
/** The channel kinds a `channel` trigger may name. */
type ChannelKind = Extract<TriggerSpec, { type: 'channel' }>['channel'];

/** One row of the Capabilities card: a fixed key, its label and the item names to chip. */
export interface CapabilityRow {
  key: 'tools' | 'mcp' | 'skills' | 'memory' | 'subagents' | 'handoffs';
  label: string;
  items: string[];
}

/** The Safety card's rollup: guardrail chips, permission-rule counts, the mode and the limit lines. */
export interface SafetySummary {
  /** One `${name} (${on})` per guardrail, e.g. `pii (both)`. */
  guardrails: string[];
  /** Rule counts by action; `permissionRuleText` renders the non-zero ones. */
  rules: Record<'allow' | 'deny' | 'ask' | 'auto', number>;
  /** The spec's `permissionMode`; the card shows 'Default' when absent. */
  permissionMode: string | undefined;
  /** Limit lines, e.g. `Max steps 12`, `Max cost $0.50`, `Max tokens 20,000`. */
  limits: string[];
}

/** Display names for the SDK's built-in tools; unknown names fall back to the spec's own spelling. */
const BUILTIN_TOOL_LABELS: Record<string, string> = {
  current_date: 'Current date',
  day_name: 'Day name',
  http_request: 'HTTP request',
  web_fetch: 'Web fetch',
  todo: 'Todo',
};

/** The channel kind's display name (the spec writes lowercase ids). */
const CHANNEL_LABELS: Record<ChannelKind, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  github: 'GitHub',
  teams: 'Teams',
  discord: 'Discord',
  http: 'HTTP',
};

/** The trigger kind's icon (PLAN's wireframe glyphs). */
const TRIGGER_ICONS: Record<TriggerSpec['type'], LucideIcon> = {
  chat: MessageSquare,
  cron: Clock,
  webhook: Webhook,
  channel: Radio,
  agent: Workflow,
};

/** The file's basename without its directory (`tools/lookup.ts` → `lookup.ts`). */
function baseName(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * The chip text for one `spec.tools` entry: the entry's `id` when it names
 * one, else the builtin/registry/hosted/file/integration it points at —
 * 'openapi' and 'hub' for the two fixed connectors.
 */
function toolItemName(tool: ToolRef): string {
  if ('id' in tool && tool.id !== undefined) return tool.id;
  if ('builtin' in tool) return BUILTIN_TOOL_LABELS[tool.builtin] ?? tool.builtin;
  if ('registry' in tool) return tool.registry;
  if ('hosted' in tool) return tool.hosted;
  if ('file' in tool) return baseName(tool.file);
  if ('integration' in tool) return tool.integration;
  if ('openapi' in tool) return 'openapi';
  return 'hub';
}

/** The chip text for one `spec.skills` entry: inline name, dir basename or registry name. */
function skillItemName(skill: SkillRef): string {
  if ('inline' in skill) return skill.inline.name;
  if ('dir' in skill) return baseName(skill.dir);
  return skill.registry;
}

/**
 * The six Capabilities rows, always in order: Tools, MCP servers, Skills,
 * Memory, Subagents, Handoffs. Each `items` list is empty when the spec
 * lacks the section — the card renders 'None' for it.
 */
export function capabilityRows(spec: AgentSpecV2): CapabilityRow[] {
  return [
    { key: 'tools', label: 'Tools', items: (spec.tools ?? []).map(toolItemName) },
    { key: 'mcp', label: 'MCP servers', items: Object.keys(spec.mcpServers ?? {}) },
    { key: 'skills', label: 'Skills', items: (spec.skills ?? []).map(skillItemName) },
    { key: 'memory', label: 'Memory', items: (spec.memory ?? []).map((slot) => slot.name) },
    { key: 'subagents', label: 'Subagents', items: Object.keys(spec.subagents ?? {}) },
    { key: 'handoffs', label: 'Handoffs', items: (spec.handoffs ?? []).map((handoff) => handoff.agent) },
  ];
}

/** The one-line summary of a trigger: `Chat`, `Cron · <expr> · <tz>`, `Webhook · /<path>`, `<Channel> channel`, `After <agent> · on <outcome>`. */
function triggerText(trigger: TriggerSpec): string {
  if (trigger.type === 'chat') return 'Chat';
  if (trigger.type === 'cron') {
    return `Cron · ${trigger.cron}${trigger.timezone === undefined ? '' : ` · ${trigger.timezone}`}`;
  }
  if (trigger.type === 'webhook') {
    const path = trigger.path.startsWith('/') ? trigger.path : `/${trigger.path}`;
    return `Webhook · ${path}`;
  }
  if (trigger.type === 'channel') return `${CHANNEL_LABELS[trigger.channel]} channel`;
  return `After ${trigger.after} · on ${trigger.on}`;
}

/** One trigger's icon and one-line text for the Triggers card. */
export function triggerLine(trigger: TriggerSpec): { icon: LucideIcon; text: string } {
  return { icon: TRIGGER_ICONS[trigger.type], text: triggerText(trigger) };
}

/** The sides a guardrail checks, with the spec's `['input','output']` default applied. */
function guardrailSides(guardrail: GuardrailSpec): string[] {
  const on = guardrail.on ?? ['input', 'output'];
  return typeof on === 'string' ? [on] : on;
}

/** A guardrail's chip text: `name (both)` for the input+output default, else the side list. */
function guardrailText(guardrail: GuardrailSpec): string {
  const sides = guardrailSides(guardrail);
  const on =
    sides.length === 2 && sides.includes('input') && sides.includes('output') ? 'both' : sides.join(' + ');
  return `${guardrail.name} (${on})`;
}

/** `Max steps 12`-style lines for every run limit the spec sets (top-level `maxSteps` wins over the limits alias). */
function limitLines(spec: AgentSpecV2): string[] {
  const limits = spec.limits;
  const lines: string[] = [];
  const maxSteps = spec.maxSteps ?? limits?.maxSteps;
  if (maxSteps !== undefined) lines.push(`Max steps ${maxSteps}`);
  if (limits?.maxCostUsd !== undefined) lines.push(`Max cost $${limits.maxCostUsd.toFixed(2)}`);
  if (limits?.maxTokens !== undefined) lines.push(`Max tokens ${limits.maxTokens.toLocaleString('en-US')}`);
  if (limits?.maxInputTokens !== undefined) lines.push(`Max input tokens ${limits.maxInputTokens.toLocaleString('en-US')}`);
  if (limits?.maxOutputTokens !== undefined) lines.push(`Max output tokens ${limits.maxOutputTokens.toLocaleString('en-US')}`);
  if (limits?.maxDurationMs !== undefined) lines.push(`Max duration ${(limits.maxDurationMs / 1000).toLocaleString('en-US')}s`);
  if (limits?.maxToolErrors !== undefined) lines.push(`Max tool errors ${limits.maxToolErrors}`);
  return lines;
}

/** The Safety card's rollup: guardrails, permission-rule counts, permission mode and limits. */
export function safetySummary(spec: AgentSpecV2): SafetySummary {
  const rules: SafetySummary['rules'] = { allow: 0, deny: 0, ask: 0, auto: 0 };
  for (const rule of spec.permissions ?? []) rules[rule.action] += 1;
  return {
    guardrails: (spec.guardrails ?? []).map(guardrailText),
    rules,
    permissionMode: spec.permissionMode,
    limits: limitLines(spec),
  };
}

/** The `allow · deny · ask · auto` counts worth showing, in that order, skipping zeros (`1 deny · 2 ask`). */
export function permissionRuleText(rules: SafetySummary['rules']): string {
  const order = ['allow', 'deny', 'ask', 'auto'] as const;
  return order
    .filter((action) => rules[action] > 0)
    .map((action) => `${rules[action]} ${action}`)
    .join(' · ');
}

/** The requirements still `missing` - the "can't run yet" banner's rows; absent or empty input gives none. */
export function missingRequirements(requirements: Requirement[] | undefined): Requirement[] {
  return (requirements ?? []).filter((requirement) => requirement.status === 'missing');
}

