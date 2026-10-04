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
import { createAgent, type CreateAgentConfig, type PerRun, type SimpleAgent } from '../createAgent';
import type { LLMProvider } from '../providers/llm';
import { loadSkills } from '../skills/loadSkills';
import type { Skill } from '../skills/defineSkill';
import { isDirectory, isFile, readText } from './fsUtil';
import type { DefinedSchedule } from '../schedules/defineSchedule';
import type { Channel } from '../channels/defineChannel';
import { loadChannels } from './loadChannels';
import { loadMemory, mergeMemory } from './loadMemory';
import { loadSchedules } from './loadSchedules';
import { loadTools, type LoadedTool } from './loadTools';
import { confineToolsToReceipt, registryWarnings, verifyReceipt, type RegistryStatus } from './registryEnforce';
import { readConfig, type AgentDirConfig } from './readConfig';
import { delegateTool, listSubagentDirs, requireDescription, type LoadedSubagent } from './subagents';
import { SDKError } from '../execution/errors';
import type { AuthFn } from '../auth/types';
import { loadAuth } from './loadAuth';

export type { AgentDirConfig } from './readConfig';
export type { Attestation, RegistryItemStatus, RegistryStatus } from './registryEnforce';

/**
 * Options that win over what the directory's files say. Same shape as
 * `createAgent()`'s options; `tools` and `skills` replace the discovered ones
 * (they are not merged). `memory` is merged with the directory's `memory/` slots by name; the override wins a clash.
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
  /** Channel names discovered in `channels/` (the file name unless the channel sets its own). */
  channels: string[];
  /** Memory slot names discovered in `memory/` (the file name unless the slot sets its own). */
  memory: string[];
  /** Whether the directory has an `auth.ts` / `.js` (N10a); only the top-level directory's counts. */
  auth: boolean;
  /**
   * The `lousho-registry.json` install receipt, when the directory has one (#272):
   * which registry items it records and whether their files still match it
   * (`attested`) or were edited or removed since (`unattested` - reported with
   * a warning, and their declared permissions are still enforced).
   */
  registry?: RegistryStatus;
}

/** The result of {@link resolveAgentDir}: ready-to-use `createAgent()` options plus what was discovered. */
export interface ResolvedAgentDir {
  /** Pass to `createAgent()` to get the agent (this is exactly what `loadAgentDir` does). */
  config: CreateAgentConfig;
  manifest: AgentDirManifest;
  /** The schedules of `schedules/`; run them with `startSchedules(agent, schedules)`. `loadAgentDir()` does not start them. */
  schedules: DefinedSchedule[];
  /** The channels of `channels/`; serve them with `createDeployedServer(agent, { channels })` or `mountChannels()`. `loadAgentDir()` does not mount them. */
  channels: Channel[];
  /**
   * The route auth of `auth.ts` (N10a, docs/auth.md): pass it to
   * `createDeployedServer(agent, { auth })` or `createRouteHandler(agent, { auth })`.
   * `loadAgentDir()` does not use it.
   */
  auth?: AuthFn | readonly AuthFn[];
}

/** The model source a parent hands down to sub-agents that do not choose their own. */
interface Inherited {
  provider?: LLMProvider;
  /** A function of the run only from overrides (LOU-V15). */
  model?: PerRun<string>;
}

/** `dir`'s `instructions.md`, trimmed (undefined when absent; empty throws LOUSHO_AGENT_DIR_INVALID). */
export async function readInstructions(dir: string): Promise<{ file: string; text: string } | undefined> {
  const file = path.join(dir, 'instructions.md');
  if (!(await isFile(file))) return undefined;
  const text = (await readText(file)).trim();
  if (text === '') {
    throw new SDKError(`loadAgentDir: ${file} is empty. Write the agent's system prompt in it.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  return { file, text };
}

/** Picks the system prompt: an override, else `instructions.md` xor the config's `instructions`. */
function chooseInstructions(
  dir: string,
  config: AgentDirConfig,
  fromFile: { file: string; text: string } | undefined,
  overrides: AgentDirOverrides
): PerRun<string> {
  const override = overrides.instructions ?? overrides.prompt;
  if (override !== undefined) return override;
  if (fromFile && config.instructions !== undefined) {
    throw new SDKError(
      `loadAgentDir: ${fromFile.file}: instructions are given twice - here and as 'instructions' in the config file. ` +
        'Keep one of them.',
      'LOUSHO_AGENT_DIR_INVALID'
    );
  }
  const text = fromFile?.text ?? config.instructions;
  if (text === undefined) {
    throw new SDKError(
      `loadAgentDir: ${dir} has no instructions. Create ${path.join(dir, 'instructions.md')} with the ` +
        "agent's system prompt, or set 'instructions' in agent.ts / agent.json / agent.yaml.",
      'LOUSHO_AGENT_DIR_INVALID'
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
  if (provider && typeof model === 'string' && model.includes('/') && overrides.model === undefined) model = undefined;
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
    throw new SDKError(`loadAgentDir: '${dir}' is not a directory. Pass the path of an agent directory.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  const { file: configFile, config } = await readConfig(dir);
  const fromFile = await readInstructions(dir);
  const instructions = chooseInstructions(dir, config, fromFile, overrides);
  const source = chooseModelSource(config, overrides, inherited);
  // #272: verify the install receipt before its code runs, then bind its tools to the accepted manifests.
  const registry = await verifyReceipt(dir);
  for (const warning of registryWarnings(registry)) console.warn(`[lousho] ${warning}`);
  const tools: LoadedTool[] = confineToolsToReceipt(dir, await loadTools(dir), registry);
  const skills = await skillsFor(dir, overrides);
  const subagents = await loadSubagents(dir, overrides, source);
  const schedules = await loadSchedules(dir);
  const channels = await loadChannels(dir);
  const memorySlots = await loadMemory(dir);
  const name = overrides.name ?? config.name ?? path.basename(dir);

  const fileTools = [...tools.map((t) => t.tool), ...subagents.map(delegateTool)];
  const assembled = {
    name,
    instructions,
    ...optional('provider', source.provider),
    ...optional('model', source.model),
    ...optional('tools', overrides.tools ?? (fileTools.length > 0 ? fileTools : undefined)),
    ...optional('memory', mergeMemory(memorySlots, overrides.memory)),
    ...optional('skills', overrides.skills ?? (skills.length > 0 ? skills : undefined)),
    ...optional('maxSteps', overrides.maxSteps ?? config.maxSteps),
    ...optional('toolConcurrency', overrides.toolConcurrency ?? config.toolConcurrency),
    ...optional('projectInstructions', overrides.projectInstructions ?? config.projectInstructions),
    ...optional('exporter', overrides.exporter),
  } as CreateAgentConfig;

  const files = [...new Set([configFile, fromFile?.file, ...tools.map((t) => t.file)])].filter(
    (f): f is string => f !== undefined
  );
  return {
    config: assembled,
    schedules,
    channels,
    manifest: {
      dir,
      name,
      ...optional('description', config.description),
      files,
      tools: tools.map((t) => t.tool.name),
      skills: skills.map((s) => s.name),
      subagents: subagents.map((s) => s.name),
      schedules: schedules.map((s) => s.name as string),
      channels: channels.map((c) => c.name),
      memory: memorySlots.map((m) => m.name),
      auth: false,
      ...optional('registry', registry),
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
 *   channels/*.ts|js                                 each default-exports a channel (defineChannel(), webhookChannel(), ...)
 *   memory/*.ts|js                                   each default-exports a memory slot (defineMemory()); part of the agent
 *   auth.ts | auth.js                                default-exports route auth (jwt(), oidc(), basic(), ...); the deployed server uses it
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
  const resolved = await resolveWith(dir, overrides, {});
  const auth = await loadAuth(resolved.manifest.dir);
  if (!auth) return resolved;
  return { ...resolved, auth: auth.auth, manifest: { ...resolved.manifest, auth: true, files: [...resolved.manifest.files, auth.file] } };
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
