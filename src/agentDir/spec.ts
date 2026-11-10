/**
 * The AgentSpec v2 ⇄ agent-directory round trip.
 *
 * The write side, `specToAgentDir(spec)`, is pure (the `yaml` package and the
 * spec types only), so it lives in `src/spec/v2/specToAgentDir.ts` where the
 * browser-safe `lousho/spec` entry can reach it; it is re-exported here so
 * the package root's API is unchanged.
 *
 * The read side, `agentDirToSpec(dir)`, reads a data-config directory
 * (agent.json / agent.yaml / agent.yml, or no config) back into a spec, also
 * reporting the directory content a spec cannot hold. For specs that use
 * only directory-expressible keys the round trip is the identity.
 *
 * SECURITY: `agentDirToSpec` never imports a file - loading a directory runs
 * its code. It reads files only (fs, `yaml`, `JSON.parse`, `loadSkills`,
 * which is markdown). A code config (`agent.ts`, `agent.js`, ...) is refused
 * with LOUSHO_SPEC_UNSUPPORTED instead.
 *
 * Node-only: it reads the filesystem, so it is exported from the package
 * root, never from a browser-safe entry.
 */
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SDKError } from '../execution/errors';
import type { PermissionRuleSpec } from '../spec/v2/permissions';
import { parseAgentSpecV2 } from '../spec/v2/parse';
import type { SkillRef } from '../spec/v2/skills';
import { specToAgentDir } from '../spec/v2/specToAgentDir';
import type { DroppedField, SpecToAgentDirResult } from '../spec/v2/specToAgentDir';
import type { AgentSpecV2, InlineAgentSpec } from '../spec/v2/types';
import type { Skill } from '../skills/defineSkill';
import { loadSkills } from '../skills/loadSkills';
import { isToolFileName } from './collectTools';
import { isDirectory, isFile, listSorted, readText } from './fsUtil';
import { findConfigFile, isCodeConfigFile } from './readConfig';
import { listSubagentDirs } from './subagents';
import { fail, validateConfig, type AgentDirConfig, type AgentDirPermissionRule } from './validateConfig';

// The pure write side moved to `src/spec/v2/specToAgentDir.ts` (S19); these
// re-exports keep `import { specToAgentDir } from 'lousho'` working.
export { specToAgentDir };
export type { DroppedField, SpecToAgentDirResult };

/** The result of {@link agentDirToSpec}: the directory read back as a spec plus what was left out. */
export interface AgentDirToSpecResult {
  /** The validated AgentSpec v2 the directory describes. */
  spec: AgentSpecV2;
  /** The directory content a spec cannot hold, and why. */
  dropped: DroppedField[];
}

/** What the readers accumulate: the spec object under construction and the dropped list. */
interface DirIn {
  /** The agent directory, resolved absolute. */
  dir: string;
  /** The validated config object (`{}` when the directory has no config file). */
  config: AgentDirConfig;
  /** The spec under construction; starts as `{ version: 2 }`. */
  spec: Record<string, unknown>;
  dropped: DroppedField[];
}

function drop(ctx: DirIn, field: string, reason: string): void {
  ctx.dropped.push({ field, reason });
}

/** `text` minus one trailing newline (LF or CRLF) - the inverse of the write side's added '\n'. */
function withoutTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** The config keys that copy into the spec unchanged (`name` defaults to the directory's basename). */
const DIR_SCALAR_KEYS = [
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

async function readScalars(ctx: DirIn): Promise<void> {
  ctx.spec.name = ctx.config.name ?? path.basename(ctx.dir);
  const config = ctx.config as Record<string, unknown>;
  for (const key of DIR_SCALAR_KEYS) {
    if (config[key] !== undefined) ctx.spec[key] = config[key];
  }
}

const MARKDOWN = /\.md$/i;

/** `instructions.md` xor the config's `instructions` (both, or an empty file, are directory errors). */
async function readInstructions(ctx: DirIn): Promise<void> {
  const file = path.join(ctx.dir, 'instructions.md');
  if (await isFile(file)) {
    const text = await readText(file);
    if (text.trim() === '') {
      throw new SDKError(`agentDirToSpec: ${file} is empty. Write the agent's system prompt in it.`, 'LOUSHO_AGENT_DIR_INVALID');
    }
    if (ctx.config.instructions !== undefined) {
      throw new SDKError(
        `agentDirToSpec: ${file}: instructions are given twice - here and as 'instructions' in the config file. Keep one of them.`,
        'LOUSHO_AGENT_DIR_INVALID'
      );
    }
    ctx.spec.instructions = withoutTrailingNewline(text);
  } else if (ctx.config.instructions !== undefined) {
    ctx.spec.instructions = ctx.config.instructions;
  }
}

async function readFamily(ctx: DirIn): Promise<void> {
  const instructionsDir = path.join(ctx.dir, 'instructions');
  const byFamily: Record<string, string> = {};
  for (const name of await listSorted(instructionsDir, (e) => e.isFile && MARKDOWN.test(e.name))) {
    const stem = name.replace(MARKDOWN, '');
    if (stem !== '') byFamily[stem] = withoutTrailingNewline(await readText(path.join(instructionsDir, name)));
  }
  if (Object.keys(byFamily).length > 0) ctx.spec.instructionsByFamily = byFamily;
}

/** One config permission rule as a spec rule: the id comes back as 'p<index+1>', `tool` arrays copy. */
function permissionSpecOf(rule: AgentDirPermissionRule, index: number): PermissionRuleSpec {
  return {
    id: `p${index + 1}`,
    tool: Array.isArray(rule.tool) ? [...rule.tool] : (rule.tool as string),
    ...(rule.when !== undefined && { when: rule.when as PermissionRuleSpec['when'] }),
    action: rule.action,
    ...(rule.reason !== undefined && { reason: rule.reason }),
    ...(rule.ttlMs !== undefined && { ttlMs: rule.ttlMs }),
  };
}

async function readPermissions(ctx: DirIn): Promise<void> {
  const rules = ctx.config.permissions;
  if (rules !== undefined) ctx.spec.permissions = rules.map(permissionSpecOf);
}

/** The config's `hooks`: a file path becomes `[{ id: 'h1', file }]`; a data config's inline hooks cannot. */
async function readHooks(ctx: DirIn): Promise<void> {
  const hooks = ctx.config.hooks;
  if (hooks === undefined) return;
  if (typeof hooks === 'string') {
    ctx.spec.hooks = [{ id: 'h1', file: hooks }];
  } else {
    drop(ctx, 'hooks', "the config's 'hooks' holds inline hook objects; a spec references a hooks file");
  }
}

async function readTools(ctx: DirIn): Promise<void> {
  const names = await listSorted(path.join(ctx.dir, 'tools'), (e) => e.isFile && isToolFileName(e.name));
  if (names.length > 0) ctx.spec.tools = names.map((name) => ({ file: `tools/${name}` }));
}

/** One loaded skill as a SkillRef: a folder holding only SKILL.md (or a loose .md) is inline; with extra files it is `{ dir }`. */
async function skillRefOf(skill: Skill): Promise<SkillRef> {
  const inline = { inline: { name: skill.name, description: skill.description, content: skill.content } };
  if (skill.directory === undefined) return inline;
  const entries = await listSorted(skill.directory, () => true);
  return entries.length === 1 && entries[0] === 'SKILL.md' ? inline : { dir: `skills/${path.basename(skill.directory)}` };
}

async function readSkills(ctx: DirIn): Promise<void> {
  const skillsDir = path.join(ctx.dir, 'skills');
  if (!(await isDirectory(skillsDir))) return;
  const refs: SkillRef[] = [];
  for (const skill of await loadSkills(skillsDir)) refs.push(await skillRefOf(skill));
  if (refs.length > 0) ctx.spec.skills = refs;
}

async function readSubagents(ctx: DirIn): Promise<void> {
  const names = await listSubagentDirs(ctx.dir);
  if (names.length === 0) return;
  const subagents: Record<string, { inline: InlineAgentSpec }> = {};
  for (const name of names) {
    const child = await agentDirToSpec(path.join(ctx.dir, 'subagents', name));
    const { version: _version, ...inline } = child.spec;
    subagents[name] = { inline: inline as InlineAgentSpec };
    for (const dropped of child.dropped) drop(ctx, `subagents.${name}.${dropped.field}`, dropped.reason);
  }
  ctx.spec.subagents = subagents;
}

/** Directory code a spec cannot hold: `memory/*`, `schedules/*`, `channels/*` and root `auth.*` / `approve.*` files. */
async function readDropped(ctx: DirIn): Promise<void> {
  for (const dirName of ['memory', 'schedules', 'channels'] as const) {
    for (const name of await listSorted(path.join(ctx.dir, dirName), (e) => e.isFile)) {
      drop(ctx, `${dirName}/${name}`, `${dirName}/${name} is code; a spec cannot hold it`);
    }
  }
  for (const stem of ['auth', 'approve'] as const) {
    for (const name of await listSorted(ctx.dir, (e) => e.isFile && new RegExp(`^${stem}\\.[cm]?[jt]s$`).test(e.name))) {
      drop(ctx, name, `${name} is code; a spec cannot hold it`);
    }
  }
  for (const key of CODE_ONLY_CONFIG_KEYS) {
    if ((ctx.config as Record<string, unknown>)[key] !== undefined) drop(ctx, key, configDropReason(key));
  }
}

/** Config keys whose value a spec cannot hold, with the reason each gets when present in the config. */
const CODE_ONLY_CONFIG_KEYS = ['approve', 'store', 'toolConcurrency', 'projectInstructions', 'provider', 'engine', 'output'] as const;

function configDropReason(key: (typeof CODE_ONLY_CONFIG_KEYS)[number]): string {
  switch (key) {
    case 'approve':
      return `'approve' names a code file; a spec cannot hold an approver`;
    case 'store':
      return `'store' wires a file store; a spec cannot hold one`;
    case 'provider':
      return `a spec names a 'provider/model' string, not a provider instance`;
    case 'engine':
      return `'engine' makes a Pi sub-agent; an inline spec cannot say that`;
    case 'output':
      return `a directory 'output' is a Standard Schema; a spec's is JSON Schema data`;
    default:
      return `a spec has no '${key}' key`;
  }
}

/** The directory readers, run in order: each is one section of the mapping table. */
const FROM_DIR: ReadonlyArray<(ctx: DirIn) => Promise<void>> = [
  readScalars,
  readInstructions,
  readFamily,
  readPermissions,
  readHooks,
  readTools,
  readSkills,
  readSubagents,
  readDropped,
];

/** Parses a data config file (JSON or YAML) and validates its shape; parse errors reuse `fail()` like readConfig's. */
async function readDataConfig(file: string | undefined): Promise<AgentDirConfig> {
  if (file === undefined) return {};
  const kind = file.endsWith('.json') ? 'JSON' : 'YAML';
  let data: unknown;
  try {
    data = kind === 'JSON' ? JSON.parse(await readText(file)) : parseYaml(await readText(file));
  } catch (error) {
    return fail(file, `invalid ${kind} (${(error as Error).message}).`);
  }
  return validateConfig(file, data);
}

/**
 * Reads a DATA-config agent directory (agent.json / agent.yaml / agent.yml,
 * or none) into a v2 spec, and reports as `dropped` the directory content a
 * spec cannot hold (`memory/*`, `schedules/*`, `channels/*`, `auth.*`,
 * `approve.*` files and the `approve`, `store`, `toolConcurrency`,
 * `projectInstructions`, `provider`, `engine`, `output` config keys).
 * `name` defaults to the directory's basename, like `loadAgentDir`. The
 * result is validated with `agentSpecV2Schema` before it is returned.
 * Never imports a file: a code config (`agent.ts`, `agent.js`, ...) throws
 * LOUSHO_SPEC_UNSUPPORTED.
 */
export async function agentDirToSpec(dir: string): Promise<AgentDirToSpecResult> {
  const resolved = path.resolve(dir);
  if (!(await isDirectory(resolved))) {
    throw new SDKError(`agentDirToSpec: '${resolved}' is not a directory. Pass the path of an agent directory.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  const configFile = await findConfigFile(resolved);
  if (configFile !== undefined && isCodeConfigFile(configFile)) {
    throw new SDKError(
      `agentDirToSpec: ${configFile} is a code config; only agent.json/agent.yaml directories can be read as a spec`,
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  const config = await readDataConfig(configFile);
  if (config.model === undefined) {
    throw new SDKError(`agentDirToSpec: ${resolved}: agent directory has no 'model'; a v2 spec needs one`, 'LOUSHO_SPEC_INVALID');
  }
  const ctx: DirIn = { dir: resolved, config, spec: { version: 2 }, dropped: [] };
  for (const read of FROM_DIR) await read(ctx);
  return { spec: parseAgentSpecV2(ctx.spec, resolved), dropped: ctx.dropped };
}
