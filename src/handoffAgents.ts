/**
 * N6: the `createAgent()` side of handoffs. Every agent registers how it runs
 * as a handoff target; an agent with `handoffs` walks the graph its targets
 * (and theirs) form, by name, to build the run's `ExecuteOptions.handoffs`
 * and to pick the agent a session turn, a crash resume or an approval
 * resume continues with.
 */

import { z } from 'zod';
import type { RunConfigContext, SimpleAgent } from './createAgent';
import type { SubagentSpec } from './execution/delegation';
import type { HandoffTarget, ResolvedHandoff } from './execution/handoffRun';
import { inheritGuardrails } from './execution/ioGuardrails';
import { ConfigurationError } from './execution/errors';
import { isRemoteSubagent } from './subagents/remoteAgent';
import { handoff, isHandoff, type Handoff, type HandoffOptions } from './handoffs';

/** How a `createAgent()` agent runs as a handoff target. */
export interface HandoffRegistration {
  /** `createAgent({ name })`; a target needs one. */
  name?: string;
  description?: string;
  /** The agent's own `handoffs` option, read at each run (so it can be filled after the agent was created). */
  handoffs: () => ReadonlyArray<SimpleAgent | Handoff> | undefined;
  /** The agent's run configuration for `ctx`; `pinned` is a resumed dynamic run's saved config. */
  resolve: (ctx: RunConfigContext, pinned?: unknown) => Promise<SubagentSpec>;
  /**
   * `createAgent()` options this agent was built with that only apply to the
   * agent a run starts with - a handoff keeps the run's approval
   * configuration, permission mode and memory slots, so e.g. a target's
   * `approve` is never consulted. Reported (once) so the setting is not silently ignored.
   */
  runLevelOptions?: readonly string[];
}

const registrations = new WeakMap<object, HandoffRegistration>();

/** Makes `agent` (a `createAgent()` result) usable as a handoff target. */
export function registerHandoffAgent(agent: object, registration: HandoffRegistration): void {
  registrations.set(agent, registration);
}

/** One handoff of an agent, checked. */
interface CheckedHandoff {
  target: object;
  registration: HandoffRegistration;
  name: string;
  toolName: string;
  description: string;
  options: HandoffOptions;
}

/** Arguments of a handoff tool without `input`. */
const DEFAULT_INPUT = z.object({ reason: z.string().optional().describe('Why the conversation is handed off, in one sentence.') });

/** `transfer_to_<name>`, with characters a tool name cannot have replaced. */
function defaultToolName(name: string): string {
  return `transfer_to_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
}

function invalid(caller: string, message: string): ConfigurationError {
  return new ConfigurationError(`${caller}: ${message}`, 'handoffs');
}

/** The registration of a handoff target, or a ConfigurationError naming what is wrong. */
function registrationOf(target: unknown, caller: string): HandoffRegistration {
  if (isRemoteSubagent(target)) throw invalid(caller, 'a remote agent (remoteAgent()) cannot be a handoff target; use it as a sub-agent instead.');
  const registration = typeof target === 'object' && target !== null ? registrations.get(target) : undefined;
  if (!registration) throw invalid(caller, 'a handoff target must be an agent created with createAgent().');
  return registration;
}

/** Agents already told about once (per target agent object). */
const warnedTargets = new WeakSet<object>();

/**
 * Warns once that `target`'s run-level options (`approve`, `approvalStore`,
 * `permissionMode`, `approvalTtlMs`, `store`, `memory`) do not apply when it
 * runs as a handoff target: a run keeps the entry agent's (the run's) across
 * a handoff. Not warned for `lead` itself - when the lead is a target (a
 * hand back), those options DO apply.
 */
function warnRunLevelOptions(target: object, lead: object, registration: HandoffRegistration, name: string, leadName: string): void {
  const options = registration.runLevelOptions;
  if (options === undefined || options.length === 0 || warnedTargets.has(target) || target === lead) return;
  warnedTargets.add(target);
  const listed = options.map((option) => `'${option}'`).join(', ');
  console.warn(
    `createAgent '${leadName}': the handoff target '${name}' was created with ${listed}, ` +
      `${options.length === 1 ? 'which applies' : 'which apply'} only to the agent a run starts with - after a handoff the run still uses the entry agent's approval, permission and memory configuration. ` +
      `Move ${options.length === 1 ? 'it' : 'them'} to '${leadName}' (or whichever agent runs start on).`
  );
}

/** Checks one entry of `handoffs`: a `createAgent()` agent with a name and a description. */
function checkHandoff(entry: SimpleAgent | Handoff, caller: string): CheckedHandoff {
  const { target, options } = isHandoff(entry) ? entry : handoff(entry);
  const registration = registrationOf(target, caller);
  const name = registration.name?.trim();
  if (!name) throw invalid(caller, "a handoff target needs a name, e.g. createAgent({ name: 'billing', description: 'Answers billing questions', ... }).");
  const description = (options.description ?? registration.description)?.trim();
  if (!description) throw invalid(caller, `the handoff target '${name}' needs a description (the model reads it to decide when to hand off): createAgent({ description }) or handoff(agent, { description }).`);
  return { target, registration, name, toolName: options.toolName ?? defaultToolName(name), description, options };
}

/**
 * Checks an agent's `handoffs`: each target from createAgent() with a name and
 * a description; names and tool names unique; no handoff to the agent itself.
 */
export function checkHandoffs(
  entries: ReadonlyArray<SimpleAgent | Handoff> | undefined,
  owner: { agent?: object; name: string },
  caller: string
): CheckedHandoff[] {
  const checked = (entries ?? []).map((entry) => checkHandoff(entry, caller));
  const names = new Set<string>();
  const toolNames = new Set<string>();
  for (const { target, name, toolName } of checked) {
    if (target === owner.agent || name === owner.name) throw invalid(caller, `agent '${owner.name}' cannot hand off to itself (or to another agent with its name).`);
    if (names.has(name)) throw invalid(caller, `two handoff targets are named '${name}'; names must be unique.`);
    if (toolNames.has(toolName)) throw invalid(caller, `two handoffs use the tool name '${toolName}'; set a different toolName on one.`);
    names.add(name);
    toolNames.add(toolName);
  }
  return checked;
}

/** An agent of a handoff graph. */
interface HandoffNode {
  agent: object;
  name: string;
  registration: HandoffRegistration;
}

/** Every agent reachable through `handoffs` from `lead`, by name; one name is one agent. */
function handoffGraph(lead: HandoffNode, caller: string): Map<string, HandoffNode> {
  const nodes = new Map<string, HandoffNode>([[lead.name, lead]]);
  const queue = [lead];
  for (let node = queue.shift(); node; node = queue.shift()) {
    for (const { target, name, registration } of checkHandoffs(node.registration.handoffs(), node, caller)) {
      const known = nodes.get(name);
      if (known && known.agent !== target) throw invalid(caller, `two different agents reachable through handoffs are named '${name}'; names must be unique across the handoff graph.`);
      if (known) continue;
      warnRunLevelOptions(target, lead.agent, registration, name, lead.name);
      const added = { agent: target, name, registration };
      nodes.set(name, added);
      queue.push(added);
    }
  }
  return nodes;
}

/** `isEnabled` for `ctx`. */
async function isEnabled(option: HandoffOptions['isEnabled'], ctx: RunConfigContext): Promise<boolean> {
  if (typeof option !== 'function') return option ?? true;
  try {
    return await option(ctx);
  } catch (error) {
    throw new ConfigurationError(`handoff: the 'isEnabled' function threw: ${error instanceof Error ? error.message : String(error)}`, 'isEnabled', 'LOUSHO_CONFIG_RESOLVER_FAILED', { cause: error });
  }
}

/** The run options of the agent a run starts with that stay the run's after a handoff, and how its own options combine with a target's. */
type LeadRunOptions = Omit<SubagentSpec, 'agent' | 'provider' | 'toolRegistry' | 'hostedTools' | 'output'>;

/**
 * A target's spec as it runs inside the lead's run: its own agent, provider,
 * tools, skills, sub-agents, reasoning and model settings; the lead's guardrails and
 * permission rules first, then its own; everything else the lead's.
 */
function asTarget(spec: SubagentSpec, lead: LeadRunOptions): SubagentSpec {
  const { output: _output, ...own } = spec;
  const permissions = lead.permissions && own.permissions ? [...lead.permissions, ...own.permissions] : (lead.permissions ?? own.permissions);
  return {
    ...own,
    ...lead,
    skills: own.skills,
    subagents: own.subagents,
    reasoning: own.reasoning,
    modelSettings: own.modelSettings,
    guardrails: inheritGuardrails(lead.guardrails, own.guardrails),
    permissions,
  };
}

/** The agent a run starts or continues with, and its handoffs. */
export interface HandoffRun {
  spec: SubagentSpec;
  handoffs: ResolvedHandoff[];
  /** Whether it is the agent the run belongs to (not a handoff target). */
  lead: boolean;
}

/**
 * Builds the handoffs of runs of `lead`: `run(active, ctx)` is the agent named
 * `active` (by the transcript's last handoff marker), or the lead when there is
 * none or no agent of that name is reachable any more.
 */
export function handoffRunner(lead: {
  /** The lead agent (read when a run starts, so it can be created after the runner). */
  agent: () => object;
  name: string;
  /** The lead's spec; `viaHandoff` when a target hands back to it. */
  spec: (ctx: RunConfigContext, pinned: unknown, viaHandoff: boolean) => Promise<SubagentSpec>;
  runOptions: LeadRunOptions;
  /** What the lead's run adds to every other agent it hands to (its memory tools). */
  target?: (spec: SubagentSpec, ctx: RunConfigContext) => SubagentSpec;
}): { has: () => boolean; run: (active: string | undefined, ctx: RunConfigContext, pinned?: unknown) => Promise<HandoffRun> } {
  const caller = `createAgent '${lead.name}'`;
  const own = () => registrationOf(lead.agent(), caller);
  const withLead = (spec: SubagentSpec, ctx: RunConfigContext) => (lead.target ? lead.target(spec, ctx) : spec);

  const handoffsOf = async (node: HandoffNode, nodes: Map<string, HandoffNode>, ctx: RunConfigContext): Promise<ResolvedHandoff[]> => {
    const resolved: ResolvedHandoff[] = [];
    for (const entry of checkHandoffs(node.registration.handoffs(), node, caller)) {
      if (!(await isEnabled(entry.options.isEnabled, ctx))) continue;
      const target = nodes.get(entry.name) as HandoffNode;
      const { inputFilter, onHandoff } = entry.options;
      resolved.push({
        name: entry.name,
        toolName: entry.toolName,
        description: entry.description,
        input: entry.options.input ?? DEFAULT_INPUT,
        spec: (input) => targetOf(target, nodes, { ...ctx, input }, undefined, true),
        ...(inputFilter && { inputFilter }),
        ...(onHandoff && { onHandoff }),
      });
    }
    return resolved;
  };

  const targetOf = async (node: HandoffNode, nodes: Map<string, HandoffNode>, ctx: RunConfigContext, pinned: unknown, viaHandoff: boolean): Promise<HandoffTarget> => {
    const spec =
      node.agent === lead.agent()
        ? await lead.spec(ctx, pinned, viaHandoff)
        : withLead(asTarget(await node.registration.resolve(ctx, pinned), lead.runOptions), ctx);
    return { ...spec, handoffs: await handoffsOf(node, nodes, ctx) };
  };

  return {
    has: () => (own().handoffs()?.length ?? 0) > 0,
    async run(active, ctx, pinned) {
      const nodes = handoffGraph({ agent: lead.agent(), name: lead.name, registration: own() }, caller);
      const node = (active !== undefined && nodes.get(active)) || (nodes.get(lead.name) as HandoffNode);
      const { handoffs = [], ...spec } = await targetOf(node, nodes, ctx, pinned, false);
      return { spec, handoffs: [...handoffs], lead: node.agent === lead.agent() };
    },
  };
}
