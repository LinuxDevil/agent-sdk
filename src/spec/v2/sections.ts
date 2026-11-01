/**
 * The section compilers S16b adds to compileSpec()'s SECTION_COMPILERS
 * (./specToAgent.ts): `skills`, `memory`, `subagents`, `handoffs`,
 * `guardrails`, `permissions`, `hooks`. Each reads its AgentSpecV2 key and
 * returns the matching createAgent() config part, or {} when the key is
 * absent. The recursive agent builder is injected — specToAgent.ts passes
 * specV2ToAgent itself — so this file never imports the compiler and the
 * module graph stays acyclic.
 */
import type { CreateAgentConfig, SimpleAgent } from '../../createAgent';
import { ConfigurationError } from '../../execution/errors';
import type { Handoff } from '../../handoffs';
import type { RemoteSubagent } from '../../subagents/types';
import type { SpecHost } from './host';
import { jsonSchemaToStandardSchema } from './jsonSchemaAdapter';
import { guardrailsFromSpec } from './resolve/guardrails';
import { handoffFromSpec } from './resolve/handoffs';
import { hooksFromSpec } from './resolve/hooks';
import { memoryFromSpec } from './resolve/memory';
import { permissionsFromSpec } from './resolve/permissions';
import { resolveSkillRef } from './resolve/skills';
import { subagentFromSpec, type SubagentHost } from './resolve/subagents';
import type { AgentSpecV2 } from './types';

/**
 * The slice of compileSpec()'s CompiledSpec these sections read through
 * `out`: only `config` — the subagents section writes the built record into
 * it and the handoffs section reads it back, so a handoff to one of this
 * spec's subagents reuses that same agent instead of building it twice.
 * Typed here, not imported from specToAgent.ts, to keep the import graph
 * one-directional.
 */
export interface SectionOut {
  config: CreateAgentConfig;
}

/** One spec section → its createAgent() config part; the shape of every SECTION_COMPILERS row. */
export type SectionCompiler = (
  spec: AgentSpecV2,
  host: SpecHost,
  out: SectionOut
) => Promise<Partial<CreateAgentConfig>>;

/** What specToAgent.ts injects so inline/`{ ref }` sub-agents compile through the full pipeline (specV2ToAgent itself). */
export type SpecAgentBuilder = (spec: AgentSpecV2, host: SpecHost) => Promise<SimpleAgent>;

/** `spec.skills` → `skills`: every ref resolves to its `Skill` list; the lists are flattened in spec order. */
const skillsSection: SectionCompiler = async (spec, host) => {
  if (spec.skills === undefined) return {};
  const lists = await Promise.all(spec.skills.map((ref) => resolveSkillRef(ref, host)));
  return { skills: lists.flat() };
};

/**
 * `spec.memory` → `memory`: each entry through memoryFromSpec, with the
 * spec's own JSON-Schema adapter wired as the slot's `toStandardSchema`
 * (so `itemJsonSchema` needs nothing extra from the host).
 */
const memorySection: SectionCompiler = async (spec, host) => {
  if (spec.memory === undefined) return {};
  const slots = await Promise.all(
    spec.memory.map((entry) => memoryFromSpec(entry, { ...host, toStandardSchema: jsonSchemaToStandardSchema }))
  );
  return { memory: slots };
};

/**
 * `spec.subagents` → `subagents`: each entry through subagentFromSpec, in
 * key order. Inline and `{ ref }` entries build through `build` (the
 * recursive compiler); the host's `loadAgentRef` is forwarded so `{ ref }`
 * works wherever the top-level host can load agent files.
 */
function subagentsSection(build: SpecAgentBuilder): SectionCompiler {
  return async (spec, host) => {
    if (spec.subagents === undefined) return {};
    const subagentHost: SubagentHost = {
      ...host,
      buildAgent: (inline) => build({ version: 2, ...inline }, host),
      loadAgentRef: host.loadAgentRef,
    };
    const subagents: Record<string, SimpleAgent | RemoteSubagent> = {};
    for (const [name, entry] of Object.entries(spec.subagents)) {
      subagents[name] = await subagentFromSpec(name, entry, subagentHost);
    }
    return { subagents };
  };
}

/**
 * The agent a `spec.handoffs[i]` entry targets: the built sub-agent when
 * `entry.agent` is one of this spec's subagent names (the subagents
 * section ran first and is the only writer of `config.subagents`, always
 * a plain record), else the host's `resolveHandoffAgent`. A remote
 * sub-agent cannot be handed to (handoffs need a local SimpleAgent), and
 * an unresolvable name fails the way handoffFromSpec's absent-resolver
 * case does.
 */
function handoffTarget(agent: string, index: number, host: SpecHost, out: SectionOut): Promise<SimpleAgent> {
  const built = (out.config.subagents as Readonly<Record<string, unknown>> | undefined)?.[agent];
  if (built !== undefined && typeof (built as SimpleAgent).send === 'function') {
    return Promise.resolve(built as SimpleAgent);
  }
  if (host.resolveHandoffAgent !== undefined) return host.resolveHandoffAgent(agent);
  return Promise.reject(
    new ConfigurationError(
      `AgentSpec v2: 'handoffs.${index}' needs a host that can resolve handoff targets; this host cannot.`,
      `handoffs.${index}`,
      'LOUSHO_SPEC_UNSUPPORTED'
    )
  );
}

/** `spec.handoffs` → `handoffs`: each entry through handoffFromSpec with the subagent-aware resolver. */
const handoffsSection: SectionCompiler = async (spec, host, out) => {
  if (spec.handoffs === undefined) return {};
  const handoffs: Handoff[] = [];
  for (let index = 0; index < spec.handoffs.length; index++) {
    const entry = spec.handoffs[index];
    handoffs.push(await handoffFromSpec(entry, { resolveHandoffAgent: (agent) => handoffTarget(agent, index, host, out) }, index));
  }
  return { handoffs };
};

/** `spec.guardrails` → `guardrails`; a list that compiles to nothing leaves the key unset. */
const guardrailsSection: SectionCompiler = async (spec) => {
  if (spec.guardrails === undefined) return {};
  const guardrails = guardrailsFromSpec(spec.guardrails);
  return guardrails === undefined ? {} : { guardrails };
};

/** `spec.permissions` → `permissions`, in order (globs become anchored RegExps in the resolver). */
const permissionsSection: SectionCompiler = async (spec) =>
  spec.permissions === undefined ? {} : { permissions: permissionsFromSpec(spec.permissions) };

/** `spec.hooks` → `hooks`: file hooks load under host.baseDir, inline ones through host.inlineHook. */
const hooksSection: SectionCompiler = async (spec, host) =>
  spec.hooks === undefined ? {} : { hooks: await hooksFromSpec(spec.hooks, host) };

/**
 * The section compilers S16b appends after S16a's four, in the order
 * compileSpec() runs them: subagents before handoffs so a handoff naming
 * one of this spec's subagents reuses the built sub-agent. `build` is the
 * recursive compiler specToAgent.ts supplies (specV2ToAgent itself), so
 * inline and `{ ref }` sub-agent specs get the same pipeline as the root.
 */
export function sectionCompilers(build: SpecAgentBuilder): readonly SectionCompiler[] {
  return [skillsSection, memorySection, subagentsSection(build), handoffsSection, guardrailsSection, permissionsSection, hooksSection];
}
