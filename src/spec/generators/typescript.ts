/**
 * specToCode(): renders a validated AgentSpec v2 as the readable TypeScript
 * ES module the Code tab shows and "Eject to project" writes — a
 * `createAgent({...})` call equivalent to specV2ToAgent(spec, host): plain
 * data is written inline and the reference forms (tools, skills, memory,
 * subagents, handoffs, guardrails, permissions, hooks, output, MCP servers)
 * are written as calls to the spec resolvers the package root exports,
 * against a module-level `host`. Same spec in → same module out.
 * Browser-safe: string building only, no `node:*` imports (the imports the
 * *generated* module needs are emitted as text).
 */
import { familyInstructions } from '../v2/familyInstructions';
import type { AgentSpecV2 } from '../v2/types';
import { toTsLiteral, tsObjectKey } from './tsLiteral';

/** specToCode() options. */
export interface SpecToCodeOptions {
  /** Import specifier the SDK is imported from in the generated module. Default '@linuxdevil/lousho'. */
  packageName?: string;
}

/**
 * The order createAgent() options are written in, fixed so the output does
 * not depend on the spec's key order: the data keys and the section keys
 * interleaved in spec order. `prompt` is emitted from `spec.promptRef` and
 * `instructions` folds `instructionsByFamily` in; neither spec key is
 * emitted on its own.
 */
const KEY_ORDER = [
  'name',
  'description',
  'model',
  'fallbackModels',
  'instructions',
  'prompt',
  'modelSettings',
  'reasoning',
  'tools',
  'mcpServers',
  'skills',
  'memory',
  'subagents',
  'subagentOptions',
  'maxSubagentDepth',
  'handoffs',
  'maxHandoffs',
  'guardrails',
  'permissions',
  'permissionMode',
  'approvalTtlMs',
  'askQuestion',
  'hooks',
  'output',
  'limits',
  'maxSteps',
  'compaction',
  'retry',
  'rateLimit',
  'promptCaching',
  'toolSearch',
  'codeMode',
] as const;

/** A KEY_ORDER entry. */
type Key = (typeof KEY_ORDER)[number];

/** Spec keys createAgent() does not take; they end the module as a `spec` export. */
const SPEC_ONLY_KEYS = ['triggers', 'abortListeners', 'flow', 'evals'] as const;

/** The two host fields every generated module sets, as they appear inside `{ ... }`. */
const HOST_FIELDS =
  'baseDir: path.dirname(fileURLToPath(import.meta.url)), resolveSecret: (name: string) => process.env[name]';

/** What a renderer may record while printing: the package-root resolvers the module imports. */
interface RenderContext {
  /** Package-root export names the generated module must import (sorted when printed). */
  imports: Set<string>;
  /** Whether `const subagents` is emitted before `createAgent` (handoffs present and subagents exist). */
  subagentsConst: boolean;
}

/** Renders the value expression of one option, or undefined when the spec key is absent. */
type SectionRenderer = (spec: AgentSpecV2, ctx: RenderContext) => string | undefined;

/** A `Promise.all([` block at option indent: one call per line at indent 4, `]` back at indent 2. */
function promiseAll(calls: readonly string[]): string {
  return calls.length === 0 ? 'Promise.all([])' : `Promise.all([\n${calls.map((call) => `    ${call},`).join('\n')}\n  ])`;
}

/** `spec.tools` → `Object.assign({}, ...(await Promise.all([resolveToolRef(<ref>, ...)])))`, like the tools compiler. */
function renderTools(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.tools === undefined) return undefined;
  ctx.imports.add('resolveToolRef');
  const agentName = toTsLiteral(spec.name, 0);
  const calls = spec.tools.map(
    (ref, index) => `resolveToolRef(${toTsLiteral(ref, 4)}, { ...host, agentName: ${agentName} }, 'tools.${index}')`
  );
  return `Object.assign({}, ...(await ${promiseAll(calls)}))`;
}

/** `spec.mcpServers` → `await resolveMcpServers(<servers>, host)`. */
function renderMcpServers(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.mcpServers === undefined) return undefined;
  ctx.imports.add('resolveMcpServers');
  return `await resolveMcpServers(${toTsLiteral(spec.mcpServers, 2)}, host)`;
}

/** `spec.skills` → `(await Promise.all([resolveSkillRef(<ref>, host), …])).flat()`. */
function renderSkills(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.skills === undefined) return undefined;
  ctx.imports.add('resolveSkillRef');
  return `(await ${promiseAll(spec.skills.map((ref) => `resolveSkillRef(${toTsLiteral(ref, 4)}, host)`))}).flat()`;
}

/** `spec.memory` → `await Promise.all([memoryFromSpec(<m>, { ...host, toStandardSchema })])`, as the memory compiler wires it. */
function renderMemory(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.memory === undefined) return undefined;
  ctx.imports.add('memoryFromSpec');
  ctx.imports.add('jsonSchemaToStandardSchema');
  const calls = spec.memory.map(
    (entry) => `memoryFromSpec(${toTsLiteral(entry, 4)}, { ...host, toStandardSchema: jsonSchemaToStandardSchema })`
  );
  return `await ${promiseAll(calls)}`;
}

/** `spec.subagents` as the record `createAgent({ subagents })` takes, at `indent` columns, built through subagentFromSpec + specV2ToAgent. */
function subagentsRecord(spec: AgentSpecV2, ctx: RenderContext, indent: number): string {
  ctx.imports.add('subagentFromSpec');
  ctx.imports.add('specV2ToAgent');
  const inner = ' '.repeat(indent + 2);
  const entries = Object.entries(spec.subagents ?? {}).map(
    ([name, entry]) =>
      `${inner}${tsObjectKey(name)}: await subagentFromSpec(${toTsLiteral(name, 0)}, ${toTsLiteral(
        entry,
        indent + 2
      )}, { ...host, buildAgent: (s) => specV2ToAgent({ version: 2, ...s }, host) }),`
  );
  return entries.length === 0 ? '{}' : `{\n${entries.join('\n')}\n${' '.repeat(indent)}}`;
}

/** `spec.subagents` → `subagents: { ... }` inline (the shorthand form is emitted by {@link optionLine} when the const exists). */
function renderSubagents(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  return spec.subagents === undefined ? undefined : subagentsRecord(spec, ctx, 2);
}

/** `spec.handoffs` → `await Promise.all([handoffFromSpec(<h>, host, <i>), …])`. */
function renderHandoffs(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.handoffs === undefined) return undefined;
  ctx.imports.add('handoffFromSpec');
  const calls = spec.handoffs.map((entry, index) => `handoffFromSpec(${toTsLiteral(entry, 4)}, host, ${index})`);
  return `await ${promiseAll(calls)}`;
}

/** `spec.guardrails` → `guardrailsFromSpec(<list>)` (synchronous, no await). */
function renderGuardrails(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.guardrails === undefined) return undefined;
  ctx.imports.add('guardrailsFromSpec');
  return `guardrailsFromSpec(${toTsLiteral(spec.guardrails, 2)})`;
}

/** `spec.permissions` → `permissionsFromSpec(<list>).rules` (synchronous, no await; `.rules` because the resolver also returns the `isAuto` predicate a `createAutoApprove` host wires separately). */
function renderPermissions(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.permissions === undefined) return undefined;
  ctx.imports.add('permissionsFromSpec');
  return `permissionsFromSpec(${toTsLiteral(spec.permissions, 2)}).rules`;
}

/** `spec.hooks` → `await hooksFromSpec(<list>, host)`. */
function renderHooks(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.hooks === undefined) return undefined;
  ctx.imports.add('hooksFromSpec');
  return `await hooksFromSpec(${toTsLiteral(spec.hooks, 2)}, host)`;
}

/** `spec.output` → `outputFromSpec(<output>)` (synchronous, no await). */
function renderOutput(spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (spec.output === undefined) return undefined;
  ctx.imports.add('outputFromSpec');
  return `outputFromSpec(${toTsLiteral(spec.output, 2)})`;
}

/** A template-literal body that evaluates to `text`: `\`, `` ` `` and `${` escaped, `\r` kept as an escape. */
function escapeTemplate(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r');
}

/** The family tail matching `spec.model`, resolved at generation time (the model is fixed in the file). */
function familyTail(spec: AgentSpecV2): string | undefined {
  const joined = familyInstructions('', spec.instructionsByFamily, spec.model);
  return joined === '' ? undefined : joined.slice(1);
}

/**
 * `spec.instructions`: a string becomes a template literal with the matching
 * `instructionsByFamily` tail folded in (exactly what S16a's data section
 * computes); `{ file }` becomes `await readFile(path.join(host.baseDir, …))`
 * plus the tail as a string concatenation.
 */
function renderInstructions(spec: AgentSpecV2): string | undefined {
  if (spec.instructions === undefined) return undefined;
  if (typeof spec.instructions === 'string') {
    return `\`${escapeTemplate(familyInstructions(spec.instructions, spec.instructionsByFamily, spec.model))}\``;
  }
  const read = `await readFile(path.join(host.baseDir, ${toTsLiteral(spec.instructions.file, 0)}), 'utf8')`;
  const tail = familyTail(spec);
  return tail === undefined ? read : `(${read}) + ${toTsLiteral(`\n${tail}`, 0)}`;
}

/** `spec.promptRef` → `prompt: '<ref>'` (createAgent resolves the registry ref). */
function renderPrompt(spec: AgentSpecV2): string | undefined {
  return spec.promptRef === undefined ? undefined : toTsLiteral(spec.promptRef, 2);
}

/** The option renderers of every key that is not printed as plain data, keyed by the KEY_ORDER name. */
const SECTION_RENDERERS: Partial<Record<Key, SectionRenderer>> = {
  instructions: renderInstructions,
  prompt: renderPrompt,
  tools: renderTools,
  mcpServers: renderMcpServers,
  skills: renderSkills,
  memory: renderMemory,
  subagents: renderSubagents,
  handoffs: renderHandoffs,
  guardrails: renderGuardrails,
  permissions: renderPermissions,
  hooks: renderHooks,
  output: renderOutput,
};

/** A data key: the spec value printed as a literal (S01b stores createAgent's own option forms). */
function dataValue(spec: AgentSpecV2, key: Key): string | undefined {
  const value = (spec as unknown as Record<string, unknown>)[key];
  return value === undefined ? undefined : toTsLiteral(value, 2);
}

/** The full `  key: value` line for one KEY_ORDER entry, or undefined when the spec does not carry it. */
function optionLine(key: Key, spec: AgentSpecV2, ctx: RenderContext): string | undefined {
  if (key === 'subagents' && ctx.subagentsConst) {
    return spec.subagents === undefined ? undefined : '  subagents';
  }
  const value = (SECTION_RENDERERS[key] ?? ((s) => dataValue(s, key)))(spec, ctx);
  return value === undefined ? undefined : `  ${key}: ${value}`;
}

/** Whether the generated host needs `resolveHandoffAgent`: a non-empty handoffs list. */
function needsHandoffResolver(spec: AgentSpecV2): boolean {
  return spec.handoffs !== undefined && spec.handoffs.length > 0;
}

/** The body lines of a `resolveHandoffAgent` that cannot serve every target from `subagents`. */
function throwingHandoffResolver(hasSubagents: boolean): string[] {
  const message = `throw new Error(\`handoff target '\${name}' is not defined in this file\`);`;
  return hasSubagents
    ? ['    const agent = subagents[name];', `    if (agent === undefined) ${message}`, '    return agent;']
    : [`    ${message}`];
}

/**
 * The `const host = { ... };` line(s): one line normally; when handoffs need
 * `resolveHandoffAgent`, either the short `subagents[name]` form (every
 * target names a subagent) or a multi-line host whose resolver looks the
 * name up and throws for a target this file does not define.
 */
function hostLines(spec: AgentSpecV2, subagentsConst: boolean): string[] {
  if (!needsHandoffResolver(spec)) return [`const host = { ${HOST_FIELDS} };`];
  const subagentNames = new Set(Object.keys(spec.subagents ?? {}));
  if (subagentsConst && (spec.handoffs ?? []).every((entry) => subagentNames.has(entry.agent))) {
    return [`const host = { ${HOST_FIELDS}, resolveHandoffAgent: async (name: string) => subagents[name] };`];
  }
  return [
    'const host = {',
    `  ${HOST_FIELDS},`,
    '  resolveHandoffAgent: async (name: string) => {',
    ...throwingHandoffResolver(subagentsConst),
    '  },',
    '};',
  ];
}

/**
 * The trailing `export const spec = { … } as const;` for the spec keys that
 * are not agent options (triggers, abortListeners, flow, evals), preceded by
 * the comment explaining who runs them. Undefined when none are present.
 */
function specKeysTrailer(spec: AgentSpecV2): string[] | undefined {
  const data = spec as unknown as Record<string, unknown>;
  const present = SPEC_ONLY_KEYS.filter((key) => data[key] !== undefined);
  if (present.length === 0) return undefined;
  const picked = Object.fromEntries(present.map((key) => [key, data[key]]));
  return [
    '// triggers, abortListeners, flow and evals are run by lousho dev / Studio, not by createAgent():',
    `export const spec = ${toTsLiteral(picked, 0)} as const;`,
  ];
}

/**
 * `spec` as a TypeScript ES module that builds the same agent with
 * `createAgent({...})` — specV2ToAgent's compile written as readable code.
 * Deterministic: two calls with the same spec return identical strings, and
 * the option order follows KEY_ORDER regardless of the input's key order.
 * `options.packageName` overrides the specifier the SDK is imported from
 * (default '@linuxdevil/lousho').
 */
export function specToCode(spec: AgentSpecV2, options?: SpecToCodeOptions): string {
  const packageName = options?.packageName ?? '@linuxdevil/lousho';
  const ctx: RenderContext = { imports: new Set(), subagentsConst: needsHandoffResolver(spec) && spec.subagents !== undefined };

  const optionLines: string[] = [];
  for (const key of KEY_ORDER) {
    const line = optionLine(key, spec, ctx);
    if (line !== undefined) optionLines.push(`${line},`);
  }
  const subagentsLines = ctx.subagentsConst ? [`const subagents = ${subagentsRecord(spec, ctx, 0)};`, ''] : [];

  const resolvers = [...ctx.imports].sort();
  const lines = [
    `// Generated by lousho from AgentSpec v2 '${spec.name.replace(/[\r\n]+/g, ' ')}'. Edit the spec, not this file.`,
    ...(typeof spec.instructions === 'object' ? [`import { readFile } from 'node:fs/promises';`] : []),
    `import path from 'node:path';`,
    `import { fileURLToPath } from 'node:url';`,
    `import { createAgent${resolvers.length > 0 ? `, ${resolvers.join(', ')}` : ''} } from ${toTsLiteral(packageName, 0)};`,
    '',
    `/** Where relative paths in the spec start, and how named secrets resolve (environment variables here). */`,
    ...hostLines(spec, ctx.subagentsConst),
    '',
    ...subagentsLines,
    `export const agent = createAgent({`,
    ...optionLines,
    `});`,
  ];
  const trailer = specKeysTrailer(spec);
  if (trailer !== undefined) lines.push('', ...trailer);
  return `${lines.join('\n')}\n`;
}
