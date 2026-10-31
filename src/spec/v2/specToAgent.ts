/**
 * specV2ToAgent(): compiles a validated AgentSpec v2 into a live
 * createAgent() agent — the async v2 counterpart of v1's sync specToAgent().
 * SECTION_COMPILERS covers the plain-data keys, `tools`, `mcpServers`,
 * `output` and, through ./sections.ts, `skills`, `memory`, `subagents`,
 * `handoffs`, `guardrails`, `permissions` and `hooks`.
 * Node-only: `instructions.file` reads under host.baseDir and the tool
 * resolvers load code, so this file is never part of the browser-safe
 * spec entry.
 */
import * as fs from 'node:fs';
import { createAgent, type CreateAgentConfig, type PromptRefString, type SimpleAgent } from '../../createAgent';
import { ConfigurationError } from '../../execution/errors';
import type { LLMProvider } from '../../providers/llm';
import { resolveSpecProvider } from '../provider';
import type { McpServerSpec } from '../schema';
import { familyInstructions } from './familyInstructions';
import { specFilePath } from './files';
import { outputFromSpec } from './jsonSchemaAdapter';
import { parseAgentSpecV2 } from './parse';
import { resolveMcpServers } from './resolve/mcpServers';
import { resolveToolRef, type ResolvedTools } from './resolve/tools';
import { sectionCompilers } from './sections';
import type { SpecHost } from './host';
import type { AgentSpecV2 } from './types';

/** The result of {@link compileSpec}: the createAgent() config plus the side data spans and diffs need. */
export interface CompiledSpec {
  /** The createAgent() options the spec compiles to. */
  config: CreateAgentConfig;
  /** Per `spec.tools[i]`, the model-facing tool names that ref produced (S20a maps spans with it). */
  toolNamesByRef: string[][];
  /** `spec.mcpServers` resolved to v1-shaped servers (the resolve/ secret-refs expanded). */
  mcpServers: Record<string, McpServerSpec>;
}

/** One section: reads its part of the spec, returns its part of the config, and may fill `out`'s side data. */
type SectionCompiler = (spec: AgentSpecV2, host: SpecHost, out: CompiledSpec) => Promise<Partial<CreateAgentConfig>>;

/** The AgentSpecV2 keys createAgent() takes unchanged (S01b already stores its own forms). */
const PASSTHROUGH_KEYS = [
  'name',
  'description',
  'fallbackModels',
  'modelSettings',
  'reasoning',
  'limits',
  'maxSteps',
  'compaction',
  'retry',
  'rateLimit',
  'promptCaching',
  'toolSearch',
  'codeMode',
  'permissionMode',
  'approvalTtlMs',
  'askQuestion',
  'subagentOptions',
  'maxSubagentDepth',
  'maxHandoffs',
] as const;

/**
 * 'provider/model' → the provider instance. The split is at the FIRST '/'
 * so 'openrouter/anthropic/x' keeps 'anthropic/x' as the model; the
 * resolution itself is v1's resolveSpecProvider(), so 'mock/…' works.
 */
function providerFor(model: string): LLMProvider {
  const slash = model.indexOf('/');
  return resolveSpecProvider(model.slice(0, slash), model.slice(slash + 1));
}

/** `spec.instructions` as text: a string as is, `{ file }` read under host.baseDir (an empty file is an error). */
async function baseInstructions(spec: AgentSpecV2, host: SpecHost): Promise<string> {
  if (typeof spec.instructions === 'string') return spec.instructions;
  const file = specFilePath(host.baseDir, 'instructions.file', spec.instructions.file);
  const text = await fs.promises.readFile(file, 'utf8');
  if (text.trim() === '') {
    throw new ConfigurationError(
      `AgentSpec v2: 'instructions.file' points at '${spec.instructions.file}', which is empty. Write the system prompt in it or use a string.`,
      'instructions',
      'LOUSHO_SPEC_INVALID'
    );
  }
  return text;
}

/**
 * The plain-data section: the pass-through keys, the 'provider/model'
 * split, instructions (+ the family tail), promptRef → `prompt`, and the
 * host's `store`/`exporter`. `triggers`, `abortListeners`, `flow` and
 * `evals` are not agent config; they stay on `agent.spec`.
 */
const dataSection: SectionCompiler = async (spec, host) => {
  const config: Record<string, unknown> = {
    provider: providerFor(spec.model),
    instructions: familyInstructions(await baseInstructions(spec, host), spec.instructionsByFamily, spec.model),
  };
  if (spec.promptRef !== undefined) config.prompt = spec.promptRef as PromptRefString;
  const data = spec as unknown as Record<string, unknown>;
  for (const key of PASSTHROUGH_KEYS) {
    if (data[key] !== undefined) config[key] = data[key];
  }
  if (host.store !== undefined) config.store = host.store;
  if (host.exporter !== undefined) config.exporter = host.exporter;
  return config as Partial<CreateAgentConfig>;
};

/**
 * `spec.tools` → one `tools` record. Each ref resolves through
 * resolveToolRef() with the spec's name as agentName; a tool name two refs
 * produce is LOUSHO_SPEC_INVALID naming both. `out.toolNamesByRef[i]` gets
 * the names ref i produced.
 */
const toolsSection: SectionCompiler = async (spec, host, out) => {
  if (spec.tools === undefined) return {};
  const merged: ResolvedTools = {};
  const producedBy = new Map<string, number>();
  for (let index = 0; index < spec.tools.length; index++) {
    const resolved = await resolveToolRef(spec.tools[index], { ...host, agentName: spec.name }, `tools.${index}`);
    out.toolNamesByRef[index] = Object.keys(resolved);
    for (const [name, tool] of Object.entries(resolved)) {
      const first = producedBy.get(name);
      if (first !== undefined) {
        throw new ConfigurationError(
          `AgentSpec v2: tool '${name}' is produced by tools.${first} and tools.${index}`,
          'tools',
          'LOUSHO_SPEC_INVALID'
        );
      }
      producedBy.set(name, index);
      merged[name] = tool;
    }
  }
  return Object.keys(merged).length === 0 ? {} : { tools: merged };
};

/** `spec.mcpServers` → `mcpServers`, secret refs resolved against the host; also kept on `out.mcpServers`. */
const mcpSection: SectionCompiler = async (spec, host, out) => {
  out.mcpServers = await resolveMcpServers(spec.mcpServers ?? {}, host);
  return spec.mcpServers === undefined ? {} : { mcpServers: out.mcpServers };
};

/** `spec.output` → `output` through the JSON-Schema → Standard-Schema adapter. */
const outputSection: SectionCompiler = async (spec) => (spec.output === undefined ? {} : { output: outputFromSpec(spec.output) });

/**
 * The section compilers, run in order: S16a's core four, then S16b's
 * skills/memory/subagents/handoffs/guardrails/permissions/hooks from
 * ./sections.ts (specV2ToAgent is passed in so inline and `{ ref }`
 * sub-agents recurse through this same pipeline — no import cycle).
 */
const SECTION_COMPILERS: readonly SectionCompiler[] = [
  dataSection,
  toolsSection,
  mcpSection,
  outputSection,
  ...sectionCompilers(specV2ToAgent),
];

/**
 * spec → createAgent config; no agent built. `spec` is taken as already
 * validated (specV2ToAgent validates first; direct callers get the
 * resolvers' errors). Each section's part is Object.assign'ed in order.
 */
export async function compileSpec(spec: AgentSpecV2, host: SpecHost): Promise<CompiledSpec> {
  const out: CompiledSpec = { config: {} as CreateAgentConfig, toolNamesByRef: [], mcpServers: {} };
  for (const compile of SECTION_COMPILERS) {
    Object.assign(out.config, await compile(spec, host, out));
  }
  return out;
}

/** The agent a v2 spec compiles to. */
export type SpecAgentV2 = SimpleAgent & {
  /** The validated spec the agent was built from. */
  readonly spec: AgentSpecV2;
  /** `spec.mcpServers` resolved to v1-shaped servers. */
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
  /** Per `spec.tools[i]`, the model-facing tool names that ref produced. */
  readonly toolNamesByRef: readonly (readonly string[])[];
};

/**
 * Validates (parseAgentSpecV2), compiles and builds the agent. The spec,
 * its resolved `mcpServers` and `toolNamesByRef` stay readable on the
 * result; `agent.close()` disconnects the MCP servers it connected.
 */
export async function specV2ToAgent(spec: AgentSpecV2, host: SpecHost): Promise<SpecAgentV2> {
  const parsed = parseAgentSpecV2(spec);
  const compiled = await compileSpec(parsed, host);
  const agent = createAgent(compiled.config);
  return Object.assign(agent, {
    spec: parsed,
    mcpServers: compiled.mcpServers,
    toolNamesByRef: compiled.toolNamesByRef,
  });
}
