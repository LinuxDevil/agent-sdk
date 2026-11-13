/**
 * The PURE write side of the AgentSpec v2 → agent-directory mapping:
 * `specToAgentDir(spec)` renders a validated spec as agent-directory files
 * (paths relative to the directory, '/' separators) plus an honest `dropped`
 * list of the fields a directory cannot hold. It only needs `yaml` and the
 * spec types, so it lives in the browser-safe `lousho/spec` entry — Studio's
 * Code tab runs it in the browser.
 *
 * The read side (`agentDirToSpec`) and the directory writers that touch the
 * filesystem stay Node-only in `src/agentDir/spec.ts`, which re-exports this
 * function so the package root's API is unchanged.
 */
import { stringify as stringifyYaml } from 'yaml';
import type { GeneratedFile } from '../generators/claude-code';
import type { PermissionRuleSpec } from './permissions';
import { TOOL_REF_KINDS, type ToolRef } from './tools';
import type { AgentSpecV2 } from './types';

/** A spec field a directory cannot hold, and why. Shown by the Code tab and the import preview. */
export interface DroppedField {
  /** Dotted path, e.g. 'guardrails', 'tools.2', 'subagents.billing'. */
  field: string;
  /** Plain words, e.g. "agent directories have no 'guardrails' key". */
  reason: string;
}

/** The result of {@link specToAgentDir}: the agent directory's files plus what was left out. */
export interface SpecToAgentDirResult {
  /** Files of the agent directory (paths relative to the directory, '/' separators). */
  files: GeneratedFile[];
  /** The spec fields a directory cannot hold, and why. */
  dropped: DroppedField[];
}

/** The spec fields the directory writers read; an inline sub-agent spec is the same minus the top-level-only keys. */
type DirSpec = Omit<AgentSpecV2, 'version' | 'triggers' | 'abortListeners' | 'flow' | 'evals'>;

/** What the writers accumulate: the generated files, the dropped fields and the agent.yaml object. */
interface DirOut {
  files: GeneratedFile[];
  dropped: DroppedField[];
  /** The config object's keys, serialized as agent.yaml in AGENT_YAML_ORDER once every writer ran. */
  config: Record<string, unknown>;
}

function dropField(out: DirOut, field: string, reason: string): void {
  out.dropped.push({ field, reason });
}

function writeFile(out: DirOut, filePath: string, content: string): void {
  out.files.push({ path: filePath, content });
}

/** The config keys that copy over unchanged (permissions and hooks are reshaped by their own writers). */
const CONFIG_SCALAR_KEYS = [
  'name',
  'description',
  'model',
  'maxSteps',
  'permissionMode',
  'approvalTtlMs',
  'limits',
  'modelSettings',
  'retry',
  'compaction',
] as const;

/** agent.yaml key order, fixed so the output does not depend on the spec's key order. */
const AGENT_YAML_ORDER = [
  'name',
  'description',
  'model',
  'maxSteps',
  'permissionMode',
  'permissions',
  'hooks',
  'approvalTtlMs',
  'limits',
  'modelSettings',
  'retry',
  'compaction',
] as const;

/** Spec keys a directory cannot express at all; each is reported as dropped. */
const NOT_A_DIR_KEY = [
  'mcpServers',
  'guardrails',
  'handoffs',
  'memory',
  'triggers',
  'output',
  'reasoning',
  'fallbackModels',
  'rateLimit',
  'promptCaching',
  'toolSearch',
  'codeMode',
  'askQuestion',
  'subagentOptions',
  'maxSubagentDepth',
  'maxHandoffs',
  'abortListeners',
  'flow',
  'evals',
  'promptRef',
] as const;

function writeScalars(spec: DirSpec, out: DirOut): void {
  const data = spec as unknown as Record<string, unknown>;
  for (const key of CONFIG_SCALAR_KEYS) {
    if (data[key] !== undefined) out.config[key] = data[key];
  }
}

function writePermissions(spec: DirSpec, out: DirOut): void {
  if (spec.permissions === undefined) return;
  // A directory rule is the same object minus the canvas `id` (reading assigns 'p1', 'p2', ...).
  // 'auto' has no directory form - a directory cannot carry the approve callback the model scoring needs -
  // so it degrades to 'ask' and the loss is reported like every other dropped field.
  out.config.permissions = spec.permissions.map(({ id: _id, ...rule }: PermissionRuleSpec, index) => {
    if (rule.action !== 'auto') return rule;
    dropField(out, `permissions.${index}.action`, "agent directories cannot express 'auto' approvals; written as 'ask'");
    return { ...rule, action: 'ask' as const };
  });
}

function writeHooks(spec: DirSpec, out: DirOut): void {
  const hooks = spec.hooks ?? [];
  const firstFile = hooks.findIndex((hook) => 'file' in hook);
  if (firstFile >= 0) out.config.hooks = (hooks[firstFile] as { file: string }).file;
  hooks.forEach((_hook, index) => {
    if (index !== firstFile) dropField(out, `hooks.${index}`, 'an agent directory holds one hooks file');
  });
}

function writeInstructions(spec: DirSpec, out: DirOut): void {
  if (typeof spec.instructions === 'string') {
    writeFile(out, 'instructions.md', `${spec.instructions}\n`);
  } else if (spec.instructions !== undefined) {
    dropField(out, 'instructions', `instructions file '${spec.instructions.file}' is not copied`);
  }
}

function writeFamily(spec: DirSpec, out: DirOut): void {
  for (const [family, text] of Object.entries(spec.instructionsByFamily ?? {})) {
    writeFile(out, `instructions/${family}.md`, `${text}\n`);
  }
}

function writeSkills(spec: DirSpec, out: DirOut): void {
  (spec.skills ?? []).forEach((ref, index) => {
    if ('inline' in ref) {
      const { name, description, content } = ref.inline;
      writeFile(out, `skills/${name}/SKILL.md`, `---\n${stringifyYaml({ name, description })}---\n\n${content}\n`);
    } else {
      dropField(out, `skills.${index}`, 'skill folders are not copied');
    }
  });
}

/** The kind key a ToolRef carries (its single discriminator), for the dropped reason. */
function toolRefKind(ref: ToolRef): string {
  return TOOL_REF_KINDS.find((kind) => kind in ref) ?? 'file';
}

/** A `{ file }` ref under tools/ needs nothing written; other refs, and ref options a directory lacks, are dropped. */
function writeTools(spec: DirSpec, out: DirOut): void {
  (spec.tools ?? []).forEach((ref, index) => {
    if ('file' in ref) {
      if (!ref.file.startsWith('tools/')) dropField(out, `tools.${index}`, `tool file '${ref.file}' is not under 'tools/'`);
      for (const key of ['approval', 'deferLoading'] as const) {
        if (ref[key] !== undefined) dropField(out, `tools.${index}`, `agent directories cannot carry '${key}' on a tool`);
      }
    } else {
      dropField(out, `tools.${index}`, `agent directories cannot reference '${toolRefKind(ref)}' tools`);
    }
  });
}

function writeSubagents(spec: DirSpec, out: DirOut): void {
  for (const [name, entry] of Object.entries(spec.subagents ?? {})) {
    if ('inline' in entry) {
      const inner = specToDir(entry.inline);
      for (const file of inner.files) writeFile(out, `subagents/${name}/${file.path}`, file.content);
      for (const dropped of inner.dropped) dropField(out, `subagents.${name}.${dropped.field}`, dropped.reason);
    } else {
      dropField(out, `subagents.${name}`, `agent directories cannot reference '${'ref' in entry ? 'ref' : 'remote'}' sub-agents`);
    }
  }
}

function writeUnsupported(spec: DirSpec, out: DirOut): void {
  const data = spec as unknown as Record<string, unknown>;
  for (const key of NOT_A_DIR_KEY) {
    if (data[key] !== undefined) dropField(out, key, `agent directories have no '${key}' key`);
  }
}

/** The directory writers, run in order: each is one section of the mapping table. */
const TO_DIR: ReadonlyArray<(spec: DirSpec, out: DirOut) => void> = [
  writeScalars,
  writePermissions,
  writeHooks,
  writeInstructions,
  writeFamily,
  writeSkills,
  writeTools,
  writeSubagents,
  writeUnsupported,
];

/** `out.config` as agent.yaml text, keys in AGENT_YAML_ORDER. */
function agentYaml(config: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of AGENT_YAML_ORDER) {
    if (config[key] !== undefined) ordered[key] = config[key];
  }
  return stringifyYaml(ordered);
}

/** The files of `spec`'s agent directory and what was left out; shared by the export and the sub-agent recursion. */
function specToDir(spec: DirSpec): SpecToAgentDirResult {
  const out: DirOut = { files: [], dropped: [], config: {} };
  for (const write of TO_DIR) write(spec, out);
  return { files: [{ path: 'agent.yaml', content: agentYaml(out.config) }, ...out.files], dropped: out.dropped };
}

/**
 * Files of the agent directory for `spec` (paths relative to the directory,
 * '/' separators), and what was left out. Pure and browser-safe: the caller
 * writes the files; `{ file }` tool refs under `tools/` write nothing because
 * the file is expected to exist already. Everything a directory cannot
 * express is listed in `dropped`, never silently lost.
 */
export function specToAgentDir(spec: AgentSpecV2): SpecToAgentDirResult {
  return specToDir(spec);
}
