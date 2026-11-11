import { parse as parseYaml } from 'yaml';
import { fail, validateConfig, type AgentDirConfig } from '../../agentDir/validateConfig';
import { modelIdSchema } from '../../spec/v2/common';
import { parseAgentSpecV2 } from '../../spec/v2/parse';
import type { AgentSpecV2 } from '../../spec/v2/types';
import { SDKError } from '../../utils/sdkError';

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
  /** Skill names, from `skills/` or the Studio spec's `skills`. */
  skills: string[];
  /** Tool files under `tools/` (relative to the agent dir), or the Studio spec's tool names; the host supplies the code, nothing here is imported. */
  tools: string[];
  /** Memory slot files under `memory/`, or the Studio spec's slot names. */
  memory: string[];
}

/** An agent's files as text keyed by path relative to its dir, and the layout they follow. */
export interface AgentFiles {
  /** `dir` is an agent folder (`agent.json`, `instructions.md`, `tools/`); `studio` is one Studio YAML spec. */
  format: 'dir' | 'studio';
  /** Where the files live, for messages. */
  dir: string;
  /** File text keyed by path relative to `dir`. */
  files: Readonly<Record<string, string>>;
}

const DATA_CONFIGS = ['agent.json', 'agent.yaml', 'agent.yml'];

const CODE_CONFIG = /^agent\.[cm]?[jt]s$/;

const CODE_FILE = /\.[cm]?[jt]s$/;

function parseData(file: string, text: string): unknown {
  try {
    return file.endsWith('.json') ? (JSON.parse(text) as unknown) : (parseYaml(text) as unknown);
  } catch (error) {
    return fail(file, `invalid ${file.endsWith('.json') ? 'JSON' : 'YAML'} (${(error as Error).message}).`);
  }
}

function configFile(agent: AgentFiles): string | undefined {
  const code = Object.keys(agent.files).find((path) => CODE_CONFIG.test(path));
  if (code !== undefined) fail(`${agent.dir}/${code}`, 'a code config cannot be read from a workspace source; use agent.json or agent.yaml.');
  const found = DATA_CONFIGS.filter((name) => name in agent.files);
  if (found.length > 1) fail(agent.dir, `has more than one config file (${found.join(', ')}). Keep exactly one.`);
  return found[0];
}

function splitVersion(file: string, value: unknown): { version?: string; rest: unknown } {
  if (typeof value !== 'object' || value === null || !('version' in value)) return { rest: value };
  const { version, ...rest } = value as Record<string, unknown>;
  if (typeof version !== 'string') fail(file, `'version' must be a string such as "1.0.0".`);
  return { version, rest };
}

function readDirConfig(agent: AgentFiles): { config: AgentDirConfig; version?: string } {
  const name = configFile(agent);
  if (name === undefined) return { config: {} };
  const file = `${agent.dir}/${name}`;
  const { version, rest } = splitVersion(file, parseData(file, agent.files[name]));
  return { config: validateConfig(file, rest), ...(version !== undefined && { version }) };
}

function checkModel(file: string, model: string | undefined): string | undefined {
  if (model !== undefined && !modelIdSchema.safeParse(model).success) fail(file, `'model' must be 'provider/model' with no spaces, got '${model}'.`);
  return model;
}

function dirInstructions(agent: AgentFiles, config: AgentDirConfig): string {
  const text = agent.files['instructions.md']?.trim();
  if (text === '') fail(`${agent.dir}/instructions.md`, "is empty. Write the agent's system prompt in it.");
  if (text !== undefined && config.instructions !== undefined) fail(`${agent.dir}/instructions.md`, "instructions are given twice - here and as 'instructions' in the config file. Keep one of them.");
  const chosen = text ?? config.instructions;
  if (chosen === undefined) fail(agent.dir, 'has no instructions. Add instructions.md or set instructions in agent.json.');
  return chosen;
}

function under(agent: AgentFiles, folder: string, keep: (rest: string) => boolean): string[] {
  return Object.keys(agent.files)
    .filter((path) => path.startsWith(`${folder}/`) && keep(path.slice(folder.length + 1)))
    .sort();
}

function skillNames(agent: AgentFiles): string[] {
  const names = under(agent, 'skills', (rest) => rest.endsWith('.md')).map((path) => path.split('/')[1].replace(/\.md$/, ''));
  return [...new Set(names)];
}

const flat = (rest: string): boolean => !rest.includes('/') && CODE_FILE.test(rest);

function readDir(agent: AgentFiles): AgentOwned {
  const { config, version } = readDirConfig(agent);
  const defaultModel = checkModel(`${agent.dir}/agent.json`, config.model);
  return {
    name: config.name ?? agent.dir.split('/').pop() ?? agent.dir,
    ...(version !== undefined && { version }),
    ...(config.description !== undefined && { description: config.description }),
    instructions: dirInstructions(agent, config),
    ...(defaultModel !== undefined && { defaultModel }),
    skills: skillNames(agent),
    tools: under(agent, 'tools', flat),
    memory: under(agent, 'memory', flat),
  };
}

const LABEL_KEYS = ['id', 'builtin', 'registry', 'file', 'hosted', 'integration', 'dir', 'name'];

function refLabel(ref: object): string {
  const record = ref as Record<string, unknown>;
  const inline = record.inline as Record<string, unknown> | undefined;
  const key = LABEL_KEYS.find((name) => typeof record[name] === 'string');
  return key !== undefined ? String(record[key]) : String(inline?.name ?? 'hub');
}

function readStudio(agent: AgentFiles): AgentOwned {
  const [file, text] = Object.entries(agent.files)[0] ?? [agent.dir, ''];
  const spec: AgentSpecV2 = parseAgentSpecV2(parseData(file, text), agent.dir);
  return {
    name: spec.name,
    ...(spec.description !== undefined && { description: spec.description }),
    ...(typeof spec.instructions === 'string' && { instructions: spec.instructions }),
    defaultModel: spec.model,
    skills: (spec.skills ?? []).map(refLabel),
    tools: (spec.tools ?? []).map(refLabel),
    memory: (spec.memory ?? []).map((slot) => slot.name),
  };
}

/** Reads an agent's owned settings from its files (the tree-to-loader adapter): configs are validated as `resolveAgentDir` validates them, and no file is imported, copied or written. */
export function readAgentOwned(agent: AgentFiles): AgentOwned {
  if (agent.format === 'studio') return readStudio(agent);
  if (Object.keys(agent.files).length === 0) throw new SDKError(`'${agent.dir}' has no files.`, 'LOUSHO_WORKSPACE_AGENT_UNRESOLVED');
  return readDir(agent);
}
