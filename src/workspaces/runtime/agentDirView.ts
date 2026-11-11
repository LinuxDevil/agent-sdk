import { parse as parseYaml } from 'yaml';
import { isToolFileName } from '../../agentDir/collectTools';
import { fail, validateConfig, type AgentDirConfig } from '../../agentDir/validateConfig';
import type { RunLimits } from '../../execution/budget';
import { hasFrontmatter, skillFromText } from '../../skills/loadSkills';
import { modelIdSchema } from '../../spec/v2/common';
import { parseAgentSpecV2 } from '../../spec/v2/parse';
import type { PermissionRuleSpec } from '../../spec/v2/permissions';
import type { AgentSpecV2 } from '../../spec/v2/types';
import { SDKError } from '../../utils/sdkError';

/** One permission rule an agent declares, in its serializable form. */
export type AgentPermission = Omit<PermissionRuleSpec, 'id'>;

/** What an agent owns, read from its files without running any of them; a page can never override these (`AGENT_OWNED`). */
export interface AgentOwned {
  /** The agent's name: the config `name`, else the folder name. */
  name: string;
  /** The agent's version, when its config has one. */
  version?: string;
  /** What the agent does. */
  description?: string;
  /** The system prompt: `instructions.md` trimmed, or the config's `instructions`. */
  instructions?: string;
  /** The agent's own default model, as `provider/model`. */
  defaultModel?: string;
  /** Skill names, as `loadSkills` names them, or the Studio spec's skill names. */
  skills: string[];
  /** Tool names: each `tools/` file's stem, or the Studio spec's tool names; the host supplies the code, nothing here is imported. */
  tools: string[];
  /** Tool files under `tools/`, relative to the agent dir: what the host must supply code for. */
  toolFiles: string[];
  /** Memory slot names: each `memory/` file's stem, or the Studio spec's slot names. */
  memory: string[];
  /** The agent's own permission rules, which a page and the workspace policy can only narrow. */
  permissions?: AgentPermission[];
  /** The agent's own run limits, which a page can only tighten. */
  limits?: RunLimits;
}

/** An agent's files as text keyed by path relative to its dir, and the layout they follow. */
export interface AgentFiles {
  /** `dir` is an agent folder (`agent.json`, `instructions.md`, `tools/`); `studio` is one Studio spec snapshot as JSON. */
  format: 'dir' | 'studio';
  /** Where the files live, for messages. */
  dir: string;
  /** File text keyed by path relative to `dir`. */
  files: Readonly<Record<string, string>>;
}

const DATA_CONFIGS = ['agent.json', 'agent.yaml', 'agent.yml'];

const CODE_ROOT_FILE = /^(?:agent|auth|hooks|approve)\.[cm]?[jt]s$/;

const CODE_KEYS = ['hooks', 'approve', 'store'] as const;

const STUDIO_CODE_KEYS = ['hooks'] as const;

function parseData(file: string, text: string): unknown {
  try {
    return file.endsWith('.json') ? (JSON.parse(text) as unknown) : (parseYaml(text) as unknown);
  } catch (error) {
    return fail(file, `invalid ${file.endsWith('.json') ? 'JSON' : 'YAML'} (${(error as Error).message}).`);
  }
}

function refuseCodeFiles(agent: AgentFiles): void {
  const code = Object.keys(agent.files).find((path) => CODE_ROOT_FILE.test(path));
  if (code !== undefined) fail(`${agent.dir}/${code}`, 'code files cannot be loaded from a workspace source; use agent.json, and let the host supply hooks, approvers and auth.');
}

function configFile(agent: AgentFiles): string | undefined {
  refuseCodeFiles(agent);
  const found = DATA_CONFIGS.filter((name) => name in agent.files);
  if (found.length > 1) fail(agent.dir, `has more than one config file (${found.join(', ')}). Keep exactly one.`);
  return found[0];
}

function refuseKeys(file: string, value: object, keys: readonly string[]): void {
  const key = keys.find((name) => name in value && (value as Record<string, unknown>)[name] !== undefined);
  if (key !== undefined) fail(file, `'${key}' needs code or a folder on disk, which a workspace source cannot give; remove it and let the host supply it.`);
}

function readDirConfig(agent: AgentFiles): { file: string; config: AgentDirConfig } {
  const name = configFile(agent);
  if (name === undefined) return { file: agent.dir, config: {} };
  const file = `${agent.dir}/${name}`;
  const config = validateConfig(file, parseData(file, agent.files[name]));
  refuseKeys(file, config, CODE_KEYS);
  return { file, config };
}

function checkModel(file: string, model: string | undefined): string | undefined {
  if (model !== undefined && !modelIdSchema.safeParse(model).success) fail(file, `'model' must be 'provider/model' with no spaces, got '${model}'.`);
  return model;
}

function dirInstructions(agent: AgentFiles, file: string, config: AgentDirConfig): string {
  const text = agent.files['instructions.md']?.trim();
  if (text === '') fail(`${agent.dir}/instructions.md`, "is empty. Write the agent's system prompt in it.");
  if (text !== undefined && config.instructions !== undefined) fail(`${agent.dir}/instructions.md`, `instructions are given twice - here and as 'instructions' in ${file}. Keep one of them.`);
  const chosen = text ?? config.instructions;
  if (chosen === undefined) fail(agent.dir, 'has no instructions. Add instructions.md or set instructions in agent.json.');
  return chosen;
}

function filesUnder(agent: AgentFiles, folder: string): string[] {
  return Object.keys(agent.files)
    .filter((path) => path.startsWith(`${folder}/`))
    .map((path) => path.slice(folder.length + 1))
    .sort();
}

function skillName(agent: AgentFiles, rest: string): string[] {
  const parts = rest.split('/');
  const file = `${agent.dir}/skills/${rest}`;
  const text = agent.files[`skills/${rest}`];
  if (parts.length === 2 && parts[1] === 'SKILL.md') return [skillFromText({ defaultName: parts[0], file, directory: `${agent.dir}/skills/${parts[0]}` }, text).name];
  if (parts.length === 1 && rest.toLowerCase().endsWith('.md') && hasFrontmatter(text)) return [skillFromText({ defaultName: rest.slice(0, -'.md'.length), file }, text).name];
  return [];
}

function codeFiles(agent: AgentFiles, folder: string): string[] {
  return filesUnder(agent, folder).filter((rest) => !rest.includes('/') && isToolFileName(rest));
}

const stem = (file: string): string => file.replace(/\.[^.]+$/, '');

function readDir(agent: AgentFiles): AgentOwned {
  const { file, config } = readDirConfig(agent);
  const defaultModel = checkModel(file, config.model);
  const tools = codeFiles(agent, 'tools');
  return {
    name: config.name ?? agent.dir.split('/').pop() ?? agent.dir,
    ...(config.version !== undefined && { version: config.version }),
    ...(config.description !== undefined && { description: config.description }),
    instructions: dirInstructions(agent, file, config),
    ...(defaultModel !== undefined && { defaultModel }),
    skills: filesUnder(agent, 'skills').flatMap((rest) => skillName(agent, rest)),
    tools: tools.map(stem),
    toolFiles: tools.map((rest) => `tools/${rest}`),
    memory: codeFiles(agent, 'memory').map(stem),
    ...(config.permissions !== undefined && { permissions: config.permissions as AgentPermission[] }),
    ...(config.limits !== undefined && { limits: config.limits }),
  };
}

const LABEL_KEYS = ['id', 'builtin', 'registry', 'file', 'hosted', 'integration', 'dir', 'name'];

function refLabel(ref: object): string {
  const record = ref as Record<string, unknown>;
  const inline = record.inline as Record<string, unknown> | undefined;
  const key = LABEL_KEYS.find((name) => typeof record[name] === 'string');
  return key !== undefined ? String(record[key]) : String(inline?.name ?? 'hub');
}

const withoutId = ({ id: _id, ...rule }: PermissionRuleSpec): AgentPermission => rule;

function readStudio(agent: AgentFiles): AgentOwned {
  const [file, text] = Object.entries(agent.files)[0] ?? [agent.dir, ''];
  const spec: AgentSpecV2 = parseAgentSpecV2(parseData(file, text), agent.dir);
  refuseKeys(agent.dir, spec, STUDIO_CODE_KEYS);
  return {
    name: spec.name,
    ...(spec.description !== undefined && { description: spec.description }),
    ...(typeof spec.instructions === 'string' && { instructions: spec.instructions }),
    defaultModel: spec.model,
    skills: (spec.skills ?? []).map(refLabel),
    tools: (spec.tools ?? []).map(refLabel),
    toolFiles: [],
    memory: (spec.memory ?? []).map((slot) => slot.name),
    ...(spec.permissions !== undefined && { permissions: spec.permissions.map(withoutId) }),
    ...(spec.limits !== undefined && { limits: spec.limits }),
  };
}

/** Reads an agent's owned settings from its files (the tree-to-loader adapter): configs are validated as `resolveAgentDir` validates them, code is refused, and no file is imported, copied or written. */
export function readAgentOwned(agent: AgentFiles): AgentOwned {
  if (agent.format === 'studio') return readStudio(agent);
  if (Object.keys(agent.files).length === 0) throw new SDKError(`'${agent.dir}' has no files.`, 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED');
  return readDir(agent);
}
