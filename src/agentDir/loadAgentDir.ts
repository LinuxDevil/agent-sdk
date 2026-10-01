/**
 * Filesystem agent loader (LOU-Y5): define an agent as a directory.
 *
 * The typed code API stays the source of truth. A directory is just another
 * way to produce the `createAgent()` options, so `loadAgentDir()` assembles
 * them and calls `createAgent()` - there is no second implementation.
 *
 * SECURITY: loading a directory executes its code (`agent.ts`, `tools/*`).
 * Only load directories you trust.
 */
import path from 'node:path';
import { createAgent, type CreateAgentConfig, type SimpleAgent } from '../createAgent';
import type { LLMProvider } from '../providers/llm';
import { loadSkills } from '../skills/loadSkills';
import type { Skill } from '../skills/defineSkill';
import { isDirectory, isFile, readText } from './fsUtil';
import type { DefinedSchedule } from '../schedules/defineSchedule';
import { loadSchedules } from './loadSchedules';
import { loadTools, type LoadedTool } from './loadTools';
import { readConfig, type AgentDirConfig } from './readConfig';
import { delegateTool, listSubagentDirs, requireDescription, type LoadedSubagent } from './subagents';

export type { AgentDirConfig } from './readConfig';

/**
 * Options that win over what the directory's files say. Same shape as
 * `createAgent()`'s options; `tools` and `skills` replace the discovered ones
 * (they are not merged).
 *
 * @example
 * ```ts
 * const agent = await loadAgentDir('./my-agent', { provider: mockModel(['hi']) });
 * ```
 */
export type AgentDirOverrides = CreateAgentConfig;

/** What `resolveAgentDir()` found, for tooling and tests. Paths are absolute; lists are sorted. */
export interface AgentDirManifest {
  /** The resolved directory. */
  dir: string;
  /** The agent's name (config `name`, else the directory name). */
  name: string;
  /** The config `description`, if any (required for sub-agents). */
  description?: string;
  /** Every config / instructions / tool file that was read (skills are listed by name only). */
  files: string[];
  /** Tool names discovered in `tools/`, in load order. */
  tools: string[];
  /** Skill names discovered in `skills/`. */
  skills: string[];
  /** Sub-agent directory names discovered in `subagents/`. */
  subagents: string[];
  /** Schedule names discovered in `schedules/` (the file name unless the schedule sets its own). */
  schedules: string[];
}

/** The result of {@link resolveAgentDir}: ready-to-use `createAgent()` options plus what was discovered. */
export interface ResolvedAgentDir {
  /** Pass to `createAgent()` to get the agent (this is exactly what `loadAgentDir` does). */
  config: CreateAgentConfig;
  manifest: AgentDirManifest;
  /** The schedules of `schedules/`; run them with `startSchedules(agent, schedules)`. `loadAgentDir()` does not start them. */
  schedules: DefinedSchedule[];
}

/** The model source a parent hands down to sub-agents that do not choose their own. */
interface Inherited {
  provider?: LLMProvider;
  model?: string;
}

async function readInstructions(dir: string): Promise<{ file: string; text: string } | undefined> {
  const file = path.join(dir, 'instructions.md');
  if (!(await isFile(file))) return undefined;
  const text = (await readText(file)).trim();
  if (text === '') {
    throw new Error(`loadAgentDir: ${file} is empty. Write the agent's system prompt in it.`);
  }
  return { file, text };
}

/** Picks the system prompt: an override, else `instructions.md` xor the config's `instructions`. */
function chooseInstructions(
  dir: string,
  config: AgentDirConfig,
  fromFile: { file: string; text: string } | undefined,
  overrides: AgentDirOverrides
): string {
  const override = overrides.instructions ?? overrides.prompt;
  if (override !== undefined) return override;
  if (fromFile && config.instructions !== undefined) {
    throw new Error(
      `loadAgentDir: ${fromFile.file}: instructions are given twice - here and as 'instructions' in the config file. ` +
        'Keep one of them.'
    );
  }
  const text = fromFile?.text ?? config.instructions;
  if (text === undefined) {
    throw new Error(
      `loadAgentDir: ${dir} has no instructions. Create ${path.join(dir, 'instructions.md')} with the ` +
        "agent's system prompt, or set 'instructions' in agent.ts / agent.json / agent.yaml."
    );
  }
  return text;
}

/** The provider / model to build with. Overrides beat files; a parent's choice is only a fallback. */
function chooseModelSource(
  config: AgentDirConfig,
  overrides: AgentDirOverrides,
  inherited: Inherited
): Inherited {
  let provider = overrides.provider ?? config.provider;
  let model = overrides.model ?? config.model;
  if (!provider && !model) {
    provider = inherited.provider;
    model = inherited.model;
  }
  // A 'provider/model' string from a file names its own provider; it cannot ride along with a provider instance.
  if (provider && model?.includes('/') && overrides.model === undefined) model = undefined;
  return { provider, model };
}

async function loadSkillsIfPresent(dir: string): Promise<Skill[]> {
  const skillsDir = path.join(dir, 'skills');
  return (await isDirectory(skillsDir)) ? loadSkills(skillsDir) : [];
}

async function loadSubagents(
  dir: string,
  overrides: AgentDirOverrides,
  inherited: Inherited
): Promise<LoadedSubagent[]> {
  const subagents: LoadedSubagent[] = [];
  const childOverrides: AgentDirOverrides = overrides.provider ? { provider: overrides.provider } : {};
  for (const name of await listSubagentDirs(dir)) {
    const childDir = path.join(dir, 'subagents', name);
    const child = await resolveWith(childDir, childOverrides, inherited);
    const description = requireDescription(childDir, child.manifest.description);
    subagents.push({ name, description, agent: createAgent(child.config) });
  }
  return subagents;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

async function resolveWith(
  rawDir: string,
  overrides: AgentDirOverrides,
  inherited: Inherited
): Promise<ResolvedAgentDir> {
  const dir = path.resolve(rawDir);
  if (!(await isDirectory(dir))) {
    throw new Error(`loadAgentDir: '${dir}' is not a directory. Pass the path of an agent directory.`);
  }
  const { file: configFile, config } = await readConfig(dir);
  const fromFile = await readInstructions(dir);
  const instructions = chooseInstructions(dir, config, fromFile, overrides);
  const source = chooseModelSource(config, overrides, inherited);
  const tools: LoadedTool[] = await loadTools(dir);
  const skills = await skillsFor(dir, overrides);
  const subagents = await loadSubagents(dir, overrides, source);
  const schedules = await loadSchedules(dir);
  const name = overrides.name ?? config.name ?? path.basename(dir);

  const fileTools = [...tools.map((t) => t.tool), ...subagents.map(delegateTool)];
  const assembled = {
    name,
    instructions,
    ...optional('provider', source.provider),
    ...optional('model', source.model),
    ...optional('tools', overrides.tools ?? (fileTools.length > 0 ? fileTools : undefined)),
    ...optional('skills', overrides.skills ?? (skills.length > 0 ? skills : undefined)),
    ...optional('maxSteps', overrides.maxSteps ?? config.maxSteps),
    ...optional('toolConcurrency', overrides.toolConcurrency ?? config.toolConcurrency),
    ...optional('projectInstructions', overrides.projectInstructions ?? config.projectInstructions),
  } as CreateAgentConfig;

  const files = [...new Set([configFile, fromFile?.file, ...tools.map((t) => t.file)])].filter(
    (f): f is string => f !== undefined
  );
  return {
    config: assembled,
    schedules,
    manifest: {
      dir,
      name,
      ...optional('description', config.description),
      files,
      tools: tools.map((t) => t.tool.name),
      skills: skills.map((s) => s.name),
      subagents: subagents.map((s) => s.name),
      schedules: schedules.map((s) => s.name as string),
    },
  };
}

/** Discovered skills, unless the caller overrides them (then the skills directory is not even read). */
async function skillsFor(dir: string, overrides: AgentDirOverrides): Promise<Skill[]> {
  return overrides.skills ? [...overrides.skills] : loadSkillsIfPresent(dir);
}

/**
 * Reads an agent directory and returns the `createAgent()` options it
 * describes, plus a manifest of what was discovered. The agent itself is not
 * created (sub-agents are, since the parent's delegate tools need them); use
 * this for tooling, tests, or to tweak the options before calling
 * `createAgent()` yourself.
 *
 * Layout (everything optional except instructions):
 *
 * ```text
 * my-agent/
 *   agent.ts | agent.js | agent.json | agent.yaml   config: model, description, maxSteps, ...
 *   instructions.md                                  system prompt
 *   tools/*.ts|js                                    each exports defineTool() tools
 *   skills/                                          same layouts as loadSkills()
 *   subagents/<name>/                                nested agent directories (need a description)
 *   schedules/*.ts|js                                each default-exports defineSchedule(); run with startSchedules()
 * ```
 *
 * Loading executes the directory's code. Only load directories you trust.
 *
 * @example
 * ```ts
 * const { config, manifest } = await resolveAgentDir('./my-agent');
 * console.log(manifest.tools, manifest.skills, manifest.subagents);
 * const agent = createAgent({ ...config, maxSteps: 3 });
 * ```
 */
export async function resolveAgentDir(
  dir: string,
  overrides: AgentDirOverrides = {}
): Promise<ResolvedAgentDir> {
  return resolveWith(dir, overrides, {});
}

/**
 * Loads an agent defined as a directory and returns what `createAgent()`
 * returns. `overrides` take precedence over the directory's files.
 *
 * Sub-agents (`subagents/<name>/`) become `delegate_to_<name>` tools on the
 * parent. They inherit the parent's model unless they set their own, and a
 * `provider` override is passed down to all of them.
 *
 * Loading executes the directory's code (`agent.ts`, `tools/*`): only load
 * directories you trust. There is no sandboxing.
 *
 * @example
 * ```ts
 * const agent = await loadAgentDir('./my-agent');
 * const { text } = await agent.send('Hello!');
 *
 * // in tests: swap the model, keep everything else
 * const testAgent = await loadAgentDir('./my-agent', { provider: mockModel(['hi']) });
 * ```
 */
export async function loadAgentDir(dir: string, overrides: AgentDirOverrides = {}): Promise<SimpleAgent> {
  return createAgent((await resolveAgentDir(dir, overrides)).config);
}
