import { alwaysAsk, checkPermission, keepOwnApproval, type PermissionContext, type PermissionRule, type PermissionToolMatcher } from '../../execution/permissions';
import { matchesHost } from '../../security/hostPattern';
import { permissionsFromSpec } from '../../spec/v2/resolve/permissions';
import type { SecretRef } from '../../spec/v2/secrets';
import { ToolRegistry } from '../../tools/ToolRegistry';
import type { ToolDescriptor } from '../../types';
import { SDKError } from '../../utils/sdkError';
import type { Attachment } from '../contracts/agentRefs';
import { secretKey, toolCovers, type EffectivePolicy } from '../contracts/policy';
import type { AgentPermission } from './agentDirView';

/** One tool the host supplies: its code, and what it declares it needs and provides. */
export interface HostTool {
  /** The tool the agent runs; the runtime never imports a workspace tool file. */
  descriptor: ToolDescriptor;
  /** Secrets the tool reads; it gets only those the policy also lists. */
  secrets?: readonly SecretRef[];
  /** Dotted capability names the tool provides, such as `image.generate`. */
  capabilities?: readonly string[];
}

/** The host's tools by name, injected by the host; an agent's `tools/<name>.ts` file maps to the host tool named `<name>`. */
export type HostToolRegistry = Readonly<Record<string, HostTool>>;

/** One tool an agent may use on a page, after the policy and the page narrowed its tools. */
export interface EffectiveTool {
  /** The tool name. */
  name: string;
  /** The host descriptor, wrapped so a tool in `approvals.require` always asks. */
  descriptor: ToolDescriptor;
  /** The secrets the tool may read: its own declared secrets that the policy lists. */
  secrets: SecretRef[];
  /** The capabilities the tool provides. */
  capabilities: readonly string[];
}

/** The tools an agent may use, and the agent tool names the host registry lacks. */
export interface EffectiveToolset {
  /** Tools in agent order. */
  tools: EffectiveTool[];
  /** Agent tool names with no host tool of that name; reported at load, never run. */
  missing: string[];
}

/** An agent's permission rules after the policy rules, and the warnings for its shadowed allows. */
export interface EffectivePermissions {
  /** `createAgent({ permissions })` rules: the decision is deny > ask > none > allow across the ceiling, workspace and agent lists. */
  rules: PermissionRule[];
  /** One line per agent `allow` a policy `deny` or `ask` shadows. */
  warnings: string[];
}

/** What the runtime needs to know about the agent: its tools, its rules and any tightening of network or sandbox. */
export interface PolicyAgent {
  /** Tool names: the agent's `tools/` file stems or Studio tool names. */
  tools: readonly string[];
  /** The agent's own permission rules. */
  permissions?: readonly AgentPermission[];
  /** Tools the agent marks `approval: 'always'`; every call asks, as for `approvals.require`. */
  approvals?: readonly string[];
  /** Hosts the agent wants; it only narrows the policy's list. */
  network?: {
    /** Lower-case hosts or `*.host` wildcards. */
    allowHosts: readonly string[];
  };
  /** The agent's sandbox wish; it can turn sandboxing on, never off. */
  sandbox?: {
    /** Whether execution must be sandboxed. */
    required: boolean;
  };
}

/** The `createAgent` options and run limits the policy yields for one agent: an attachment or the main agent. */
export interface AgentPolicyOptions {
  /** `createAgent({ tools })`: only the effective toolset. */
  tools: Record<string, ToolDescriptor>;
  /** The same tools as a registry, for a workflow's `toolCall` steps (`flowToolGate`). */
  toolRegistry: ToolRegistry;
  /** `createAgent({ permissions })`. */
  permissions: PermissionRule[];
  /** Secrets by tool name; a tool absent here reads none. */
  secrets: Record<string, SecretRef[]>;
  /** Outbound hosts the agent's tools may reach. */
  network: {
    /** Allowed hosts. */
    allowHosts: string[];
  };
  /** Execution isolation. */
  sandbox: {
    /** Whether execution must be sandboxed. */
    required: boolean;
  };
  /** Load-time warnings: shadowed allows and agent tools the host lacks. */
  warnings: string[];
}

/** The policy applied to one page at start: options per attachment alias. */
export interface PagePolicy {
  /** Options by attachment alias. */
  attachments: Record<string, AgentPolicyOptions>;
  /** Every attachment's warnings, prefixed with its alias. */
  warnings: string[];
}

/** One resolved attachment as {@link pagePolicy} reads it. */
export interface PolicyAttachment {
  /** The alias the page uses. */
  alias: string;
  /** The agent's owned tools and rules. */
  agentOwned: PolicyAgent;
  /** The attachment as written in `agents.json`. */
  pageOwned: Pick<Attachment, 'tools'>;
}

const anyCovers = (patterns: readonly string[], name: string): boolean => patterns.some((pattern) => toolCovers(pattern, name));

function approvalOf(policy: EffectivePolicy, name: string, own: ToolDescriptor['needsApproval']): ToolDescriptor['needsApproval'] {
  if (anyCovers(policy.approvals.require, name)) return alwaysAsk(own);
  return own === undefined || own === false ? own : keepOwnApproval(own);
}

function effectiveTool(policy: EffectivePolicy, name: string, host: HostTool): EffectiveTool {
  const listed = new Set(policy.secrets.map(secretKey));
  const needsApproval = approvalOf(policy, name, host.descriptor.needsApproval);
  const descriptor = needsApproval === host.descriptor.needsApproval ? host.descriptor : { ...host.descriptor, needsApproval };
  return { name, descriptor, secrets: (host.secrets ?? []).filter((ref) => listed.has(secretKey(ref))), capabilities: host.capabilities ?? [] };
}

/** The tools an agent may use: `agentTools ∩ registry ∩ policy.tools.allow ∩ (attachment.tools.only ?? all)`, where `policy` is already narrowed by the host ceiling. */
export function effectiveToolset(
  policy: EffectivePolicy,
  attachment: Pick<Attachment, 'tools'> | undefined,
  agentTools: readonly string[],
  registry: HostToolRegistry
): EffectiveToolset {
  const only = attachment?.tools?.only;
  const known = (name: string): boolean => Object.hasOwn(registry, name);
  const kept = [...new Set(agentTools)].filter((name) => known(name) && anyCovers(policy.tools.allow, name) && (only === undefined || only.includes(name)));
  return { tools: kept.map((name) => effectiveTool(policy, name, registry[name])), missing: agentTools.filter((name) => !known(name)) };
}

const matcherCovers = (matcher: PermissionToolMatcher, name: string): boolean => {
  if (typeof matcher === 'string') return matcher === '*' || matcher === name;
  if (matcher instanceof RegExp) return name.search(matcher) !== -1;
  return matcher.some((entry) => matcherCovers(entry, name));
};

async function firstIndex(list: readonly PermissionRule[], args: Record<string, unknown>, ctx: PermissionContext): Promise<number> {
  return (await checkPermission({ permissions: list }, { ...ctx, args }))?.rule?.index ?? -1;
}

function firstMatchOnly(list: readonly PermissionRule[], index: number): PermissionRule {
  return { ...list[index], when: async (args, ctx) => (await firstIndex(list, args, ctx)) === index };
}

function rulesWith(lists: readonly (readonly PermissionRule[])[], action: PermissionRule['action']): PermissionRule[] {
  return lists.flatMap((list) => list.flatMap((rule, index) => (rule.action === action ? [firstMatchOnly(list, index)] : [])));
}

const matcherNames = (matcher: PermissionToolMatcher): string[] => {
  if (typeof matcher === 'string') return [matcher];
  return matcher instanceof RegExp ? [] : matcher.flatMap(matcherNames);
};

const shadows = (rule: PermissionRule, allowed: string): boolean => matcherCovers(rule.tool, allowed) || matcherNames(rule.tool).some((name) => toolCovers(allowed, name));

const unconditional = (policy: EffectivePolicy): PermissionRule[] =>
  [...permissionsFromSpec(policy.permissions.ceiling), ...permissionsFromSpec(policy.permissions.workspace)].filter((rule) => rule.when === undefined);

function shadowWarnings(policy: EffectivePolicy, agentRules: readonly AgentPermission[]): string[] {
  const blocking = unconditional(policy).filter((rule) => rule.action !== 'allow');
  return agentRules
    .filter((rule) => rule.action === 'allow')
    .flatMap((rule) => (Array.isArray(rule.tool) ? rule.tool : [rule.tool]))
    .filter((name) => blocking.some((rule) => shadows(rule, name)))
    .map((name) => `the agent allows '${name}', but a workspace or host policy rule denies or asks for it first; the allow never applies`);
}

/** An agent's permission rules under the policy: a ceiling or workspace deny or ask always holds, and an agent allow applies only where the policy decides nothing. */
export function effectivePermissions(policy: EffectivePolicy, agentPerms: readonly AgentPermission[] | undefined): EffectivePermissions {
  const ceiling = permissionsFromSpec(policy.permissions.ceiling);
  const workspace = permissionsFromSpec(policy.permissions.workspace);
  const agent = permissionsFromSpec((agentPerms ?? []).map((rule, index) => ({ ...rule, id: `agent-${index}` })));
  const all = [ceiling, workspace, agent];
  return {
    rules: [...rulesWith(all, 'deny'), ...rulesWith(all, 'ask'), ...rulesWith([agent], 'allow')],
    warnings: shadowWarnings(policy, agentPerms ?? []),
  };
}

function tightenHosts(policy: readonly string[], agent: readonly string[] | undefined): string[] {
  if (agent === undefined) return [...policy];
  return [...new Set([...agent.filter((host) => matchesHost(policy, host)), ...policy.filter((host) => matchesHost(agent, host))])];
}

function withAgentApprovals(policy: EffectivePolicy, approvals: readonly string[] = []): EffectivePolicy {
  return approvals.length === 0 ? policy : { ...policy, approvals: { require: [...policy.approvals.require, ...approvals] } };
}

function missingToolWarning(name: string): string {
  return `the agent's tool '${name}' (tools/${name}.*) has no host tool of that name; a tool file's name is its tool name, so the tool is left out`;
}

/** The `createAgent` options for one agent on a page (an attachment) or for the main agent (no attachment); no other path builds an agent's toolset. */
export function agentPolicyOptions(policy: EffectivePolicy, input: { attachment?: Pick<Attachment, 'tools'>; agent: PolicyAgent }, registry: HostToolRegistry): AgentPolicyOptions {
  const set = effectiveToolset(withAgentApprovals(policy, input.agent.approvals), input.attachment, input.agent.tools, registry);
  const permissions = effectivePermissions(policy, input.agent.permissions);
  const tools = Object.fromEntries(set.tools.map((entry) => [entry.name, entry.descriptor]));
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(tools);
  return {
    tools,
    toolRegistry,
    permissions: permissions.rules,
    secrets: Object.fromEntries(set.tools.filter((entry) => entry.secrets.length > 0).map((entry) => [entry.name, entry.secrets])),
    network: { allowHosts: tightenHosts(policy.network.allowHosts, input.agent.network?.allowHosts) },
    sandbox: { required: policy.sandbox.required || input.agent.sandbox?.required === true },
    warnings: [...permissions.warnings, ...set.missing.map(missingToolWarning)],
  };
}

function capabilitiesOf(policy: EffectivePolicy, options: readonly AgentPolicyOptions[], registry: HostToolRegistry): Set<string> {
  const denied = unconditional(policy).filter((rule) => rule.action === 'deny');
  const usable = (name: string): boolean => !denied.some((rule) => matcherCovers(rule.tool, name));
  return new Set(options.flatMap((option) => Object.keys(option.tools).filter(usable).flatMap((name) => registry[name].capabilities ?? [])));
}

/** Applies the policy to a page at start: options for every attachment, and `LOUSHO_WORKSPACE_CAPABILITY_MISSING` (`capability-missing`) when `capabilities` names something no effective tool provides. */
export function pagePolicy(
  policy: EffectivePolicy,
  page: { capabilities?: readonly string[]; attachments: readonly PolicyAttachment[] },
  registry: HostToolRegistry
): PagePolicy {
  const entries = page.attachments.map((attachment) => [attachment.alias, agentPolicyOptions(policy, { attachment: attachment.pageOwned, agent: attachment.agentOwned }, registry)] as const);
  const provided = capabilitiesOf(policy, entries.map(([, options]) => options), registry);
  const missing = (page.capabilities ?? []).filter((capability) => !provided.has(capability));
  if (missing.length > 0) {
    throw new SDKError(
      `capability-missing: the page requires ${missing.map((name) => `'${name}'`).join(', ')}, which no tool in its effective toolset provides.`,
      'LOUSHO_WORKSPACE_CAPABILITY_MISSING'
    );
  }
  return {
    attachments: Object.fromEntries(entries),
    warnings: entries.flatMap(([alias, options]) => options.warnings.map((warning) => `${alias}: ${warning}`)),
  };
}
