/**
 * resolveToolRef(): builds the real tools one validated `spec.tools` entry
 * stands for — `{ builtin }` through the factories of
 * `src/tools/builtinRegistry.ts`, `{ hosted }` through the provider-tool
 * helpers, `{ hub }` through `hubTools()` (no tools when no hub is
 * configured). The ref's `approval`/`deferLoading` flags land on every tool
 * it yields (DefinedTools go back through `defineTool`, which re-validates).
 * `{ file }`, `{ registry }`, `{ integration }` and `{ openapi }` throw
 * LOUSHO_SPEC_UNSUPPORTED here — S04b and S05 replace them. Node-side: the
 * factories pull in `node:*`; the schema stays in `../tools.ts`.
 */
import { ConfigurationError } from '../../../execution/errors';
import { hubTools } from '../../../observe/hubClient';
import { BUILTIN_TOOL_FACTORIES } from '../../../tools/builtinRegistry';
import { defineTool, isDefinedTool } from '../../../tools/defineTool';
import {
  codeInterpreter,
  fileSearch,
  webSearch,
  type CodeInterpreterOptions,
  type FileSearchOptions,
  type HostedTool,
  type WebSearchOptions,
} from '../../../tools/hosted';
import type { ToolDescriptor } from '../../../types';
import { BUILTIN_TOOL_NAMES, TOOL_REF_KINDS, type ToolRef, type ToolRefCommon, type ToolRefKind } from '../tools';
import type { SecretHost } from './secrets';

/** What resolveToolRef needs from the host; S16's host extends it. */
export interface ToolRefHost extends SecretHost {
  /** Directory file/registry refs resolve against (S04b). */
  baseDir?: string;
  /** The agent's name, for hub tools' identity. */
  agentName?: string;
}

/** Tools keyed by the model-facing name; `createAgent({ tools })` accepts this record as is. */
export type ResolvedTools = Record<string, ToolDescriptor | HostedTool>;

/** The `approval`/`deferLoading` flags a ref asks to stamp on its tools; undefined when it carries none. */
function refFlags(ref: ToolRef): { needsApproval?: boolean; deferLoading?: boolean } | undefined {
  const common: ToolRefCommon = 'approval' in ref || 'deferLoading' in ref ? ref : {};
  if (common.approval === undefined && common.deferLoading === undefined) return undefined;
  return {
    ...(common.approval === 'always' && { needsApproval: true }),
    ...(common.approval === 'never' && { needsApproval: false }),
    ...(common.deferLoading !== undefined && { deferLoading: common.deferLoading }),
  };
}

/**
 * `tools` with the ref's flags on each entry: a DefinedTool is spread back
 * into `defineTool` (which re-validates and re-brands it), anything else —
 * a HostedTool — gets a plain copy.
 */
function applyRefFlags(tools: ResolvedTools, ref: ToolRef): ResolvedTools {
  const flags = refFlags(ref);
  if (flags === undefined) return tools;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, isDefinedTool(tool) ? defineTool({ ...tool, ...flags }) : { ...tool, ...flags }])
  );
}

/** The LOUSHO_SPEC_UNSUPPORTED throw for the kinds S04b/S05 will resolve. */
function unsupported(kind: ToolRefKind, field: string): never {
  throw new ConfigurationError(
    `AgentSpec v2: '${field}' (${kind} tool reference) cannot be resolved by this version of the SDK.`,
    field,
    'LOUSHO_SPEC_UNSUPPORTED'
  );
}

/** `{ builtin: name }` → `BUILTIN_TOOL_FACTORIES[name](options)`; an unvalidated unknown name is LOUSHO_SPEC_INVALID. */
function builtinTools(name: string, options: Record<string, unknown> | undefined, field: string): ResolvedTools {
  const factory = Object.hasOwn(BUILTIN_TOOL_FACTORIES, name)
    ? BUILTIN_TOOL_FACTORIES[name as keyof typeof BUILTIN_TOOL_FACTORIES]
    : undefined;
  if (factory === undefined) {
    throw new ConfigurationError(
      `AgentSpec v2: '${field}' names unknown builtin tool '${name}'. Available: ${BUILTIN_TOOL_NAMES.join(', ')}.`,
      field,
      'LOUSHO_SPEC_INVALID'
    );
  }
  return factory(options ?? {});
}

/** `{ hosted: kind }` → one provider tool under its own name. */
function hostedTools(kind: 'web_search' | 'code_interpreter' | 'file_search', options: Record<string, unknown> | undefined): ResolvedTools {
  const build = {
    web_search: (o: Record<string, unknown>) => webSearch(o as WebSearchOptions),
    code_interpreter: (o: Record<string, unknown>) => codeInterpreter(o as CodeInterpreterOptions),
    file_search: (o: Record<string, unknown>) => fileSearch(o as unknown as FileSearchOptions),
  }[kind];
  const tool = build(options ?? {});
  return { [tool.name]: tool };
}

/** `{ hub: true }` → `hub_publish`/`hub_query`, or nothing when no collector is configured. */
function hubToolsRecord(host: ToolRefHost): ResolvedTools {
  return Object.fromEntries(hubTools({ agentName: host.agentName }).map((tool) => [tool.name, tool]));
}

/** The resolver of each kind, keyed so the dispatch is a lookup, not a switch. */
const RESOLVERS: Record<ToolRefKind, (ref: ToolRef, host: ToolRefHost, field: string) => Promise<ResolvedTools>> = {
  builtin: async (ref, _host, field) =>
    'builtin' in ref ? applyRefFlags(builtinTools(ref.builtin, ref.options, field), ref) : unsupported('builtin', field),
  registry: async (_ref, _host, field) => unsupported('registry', field),
  file: async (_ref, _host, field) => unsupported('file', field),
  integration: async (_ref, _host, field) => unsupported('integration', field),
  openapi: async (_ref, _host, field) => unsupported('openapi', field),
  hosted: async (ref, _host, field) =>
    'hosted' in ref ? applyRefFlags(hostedTools(ref.hosted, ref.options), ref) : unsupported('hosted', field),
  hub: async (ref, host) => applyRefFlags(hubToolsRecord(host), ref),
};

/**
 * Builds the tools one validated ToolRef stands for. `field` (e.g. 'tools.2')
 * names it in errors. file/registry/integration/openapi throw
 * ConfigurationError LOUSHO_SPEC_UNSUPPORTED here (S04b, S05 replace them).
 */
export async function resolveToolRef(ref: ToolRef, host: ToolRefHost, field: string): Promise<ResolvedTools> {
  const kind = TOOL_REF_KINDS.find((candidate) => candidate in ref);
  if (kind === undefined) {
    throw new ConfigurationError(`AgentSpec v2: '${field}' is not a tool reference.`, field, 'LOUSHO_SPEC_INVALID');
  }
  return RESOLVERS[kind](ref, host, field);
}
