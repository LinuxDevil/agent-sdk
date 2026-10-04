/**
 * An agent directory inside a Cloudflare Worker bundle (M3b, and #298 for
 * `subagents/` / `schedules/` / `channels/` / `memory/` / `projectInstructions`).
 *
 * `resolveAgentDir()` reads the directory from disk and imports its files at
 * run time; a Worker has neither a file system nor dynamic `import()` of
 * arbitrary paths. So `lousho build --target=cloudflare-worker` reads the
 * directory on Node at build time and generates `agent.module.ts`: static
 * imports of the code files (tools, an `agent.ts` / `agent.js` config, and the
 * `schedules/` / `channels/` / `memory/` files - each `subagents/<name>/`
 * directory recursively), and the instructions, a JSON/YAML config, the skills
 * and the project-instructions file embedded as JSON. This module turns that
 * {@link WorkerAgentDir} into `createAgent()` options with the same rules as
 * `resolveAgentDir()` (config validation, tool collection, file-name stems as
 * names), plus what the Worker target cannot do. Node-free: it runs inside
 * the Worker.
 */
import { collectTools, type ToolModule } from '../agentDir/collectTools';
import { validateConfig, type AgentDirConfig } from '../agentDir/validateConfig';
import type { DefinedTool } from '../tools/defineTool';
import type { Skill } from '../skills/defineSkill';
import type { LLMProvider } from '../providers/llm';
import type { ToolConcurrency } from '../execution/toolBatch';
import type { Channel } from '../channels/defineChannel';
import { defineChannel } from '../channels/defineChannel';
import { defineSchedule, isDefinedSchedule, type DefinedSchedule } from '../schedules/defineSchedule';
import { defineMemory, type MemorySlot } from '../memory/defineMemory';
import { SDKError } from '../execution/errors';
import { WORKER_SUPPORTED_PROVIDERS } from './workerSupport';

/** A sub-agent directory of `subagents/<name>/`, embedded like the parent's. */
export interface WorkerSubagentDir {
  /** The directory name (`subagents/<name>/`); also the `delegate_to_<name>` tool's suffix. */
  name: string;
  dir: WorkerAgentDir;
}

/** The AGENTS.md / CLAUDE.md text `projectInstructions` appends, embedded at build time. */
export interface WorkerProjectInstructions {
  /** Base name of the file found (e.g. `AGENTS.md`). */
  file: string;
  content: string;
}

/** What `agent.module.ts` exports: an agent directory as data and statically imported modules. */
export interface WorkerAgentDir {
  /** The directory's base name: the agent's name unless the config sets one. */
  name: string;
  /** The trimmed text of `instructions.md`, when the directory has one. */
  instructions?: string;
  /** The config file's name (e.g. `agent.json`), when the directory has one. */
  configFile?: string;
  /** A JSON / YAML config, parsed at build time. */
  config?: unknown;
  /** An `agent.ts` / `agent.js` config module (its default export is the config). */
  configModule?: Record<string, unknown>;
  /** The `tools/` files, sorted by file name; `file` is relative to the directory. */
  toolModules: readonly ToolModule[];
  /** The skills of `skills/`, read at build time. */
  skills: readonly Skill[];
  /** The `schedules/` files, sorted; each default-exports a `defineSchedule()` schedule. */
  scheduleModules?: readonly ToolModule[];
  /** The `channels/` files, sorted; each default-exports a channel (`defineChannel()`, `httpChannel()`, ...). */
  channelModules?: readonly ToolModule[];
  /** The `memory/` files, sorted; each default-exports a `defineMemory()` slot. */
  memoryModules?: readonly ToolModule[];
  /** The `subagents/<name>/` directories, embedded the same way as this directory. */
  subagents?: readonly WorkerSubagentDir[];
  /** The project-instructions file found at build time, when the config's `projectInstructions` asks for one. */
  projectInstructions?: WorkerProjectInstructions;
}

/** The model of a Worker agent: a provider instance from `agent.ts`, or a provider type to create with the Worker's API key binding. */
export type WorkerAgentModel =
  | { provider: LLMProvider; model?: string }
  | { providerType: string; model: string };

/** A resolved `subagents/<name>/` entry: `dir` resolved like the parent's, with the description the parent model reads. */
export interface ResolvedWorkerSubagent {
  name: string;
  description: string;
  dir: ResolvedWorkerAgentDir;
}

/** The `createAgent()` options of a {@link WorkerAgentDir}, minus what needs the Worker's `env`. */
export interface ResolvedWorkerAgentDir {
  name: string;
  instructions: string;
  model: WorkerAgentModel;
  tools: DefinedTool[];
  skills: readonly Skill[];
  maxSteps?: number;
  toolConcurrency?: ToolConcurrency;
  /** The `schedules/` schedules; run them with `handleScheduled()` from the Worker's `scheduled()` export. */
  schedules: DefinedSchedule[];
  /** The `channels/` channels; mounted under `/channels` by the Worker runtime. */
  channels: Channel[];
  /** The `memory/` slots; `kvMemory()` providers are bound to `env` when the agent is created. */
  memory: readonly MemorySlot[];
  /** The `subagents/` sub-agents; the Worker runtime adds a `delegate_to_<name>` tool per name. */
  subagents: readonly ResolvedWorkerSubagent[];
}

function unsupported(message: string): never {
  throw new SDKError(`cloudflare-worker: ${message} Use --target=node-server or --target=docker.`, 'LOUSHO_DEPLOY_FAILED');
}

function invalid(message: string): never {
  throw new SDKError(`loadAgentDir: ${message}`, 'LOUSHO_AGENT_DIR_INVALID');
}

function readDirConfig(dir: WorkerAgentDir): AgentDirConfig {
  if (dir.configFile === undefined) return {};
  const mod = dir.configModule;
  const value = mod ? ('default' in mod ? mod.default : mod) : dir.config;
  return validateConfig(dir.configFile, value);
}

function chooseInstructions(dir: WorkerAgentDir, config: AgentDirConfig): string {
  if (dir.instructions !== undefined && config.instructions !== undefined) {
    invalid(`${dir.name}/instructions.md: instructions are given twice - here and as 'instructions' in ${dir.configFile}. Keep one of them.`);
  }
  const text = dir.instructions ?? config.instructions;
  if (text === undefined) {
    invalid(`${dir.name} has no instructions. Create instructions.md with the agent's system prompt, or set 'instructions' in the config file.`);
  }
  return text;
}

/**
 * The `## Project instructions` block `createAgent({ projectInstructions })`
 * would append, from the file the build embedded (a Worker has no file system
 * to search at run time). A code config's option object is only known here,
 * after the build embedded the default AGENTS.md / CLAUDE.md search - an
 * option that cannot match it is refused.
 */
function projectInstructionsBlock(dir: WorkerAgentDir, config: AgentDirConfig): string {
  const option = config.projectInstructions;
  if (!option) return '';
  if (dir.configModule !== undefined && typeof option === 'object') {
    unsupported(
      `${dir.configFile} sets 'projectInstructions' to an options object the build could not see: use ` +
        `'projectInstructions: true' (the AGENTS.md / CLAUDE.md nearest the directory is embedded), or a JSON/YAML config.`
    );
  }
  const found = dir.projectInstructions;
  if (found === undefined) return '';
  return `\n\n## Project instructions (from ${found.file})\n\n${found.content}`;
}

/**
 * Same precedence as `resolveAgentDir()`: a provider instance wins and drops a
 * `provider/model` string; otherwise the string names a Worker provider. With
 * neither, a sub-agent inherits `inherited` (the parent's choice, as
 * `resolveAgentDir()`'s sub-agents do); the top-level directory gets
 * LOUSHO_DEPLOY_FAILED instead - a Worker has no environment to pick a model.
 */
function chooseModel(dir: WorkerAgentDir, config: AgentDirConfig, inherited?: WorkerAgentModel): WorkerAgentModel {
  const where = dir.configFile ?? `the agent directory '${dir.name}'`;
  if (config.provider) {
    const model = config.model && !config.model.includes('/') ? config.model : undefined;
    return model === undefined ? { provider: config.provider } : { provider: config.provider, model };
  }
  if (config.model === undefined) {
    if (inherited !== undefined) return inherited;
    unsupported(`${where} sets no model, and a Worker has no environment to pick one from. Set 'model', e.g. "openai/gpt-4o-mini", in the config file.`);
  }
  const slash = config.model.indexOf('/');
  if (slash <= 0 || slash === config.model.length - 1) {
    unsupported(`${where}: 'model' must be a 'provider/model' string such as "openai/gpt-4o-mini", got '${config.model}'.`);
  }
  const providerType = config.model.slice(0, slash).toLowerCase();
  if (!WORKER_SUPPORTED_PROVIDERS.includes(providerType)) {
    unsupported(`${where}: model '${config.model}' uses provider '${providerType}', which the cloudflare-worker target does not support (supported: ${WORKER_SUPPORTED_PROVIDERS.join(', ')}).`);
  }
  return { providerType, model: config.model.slice(slash + 1) };
}

const STEM = /\.[cm]?[jt]s$/;

/** `modules`' default exports, each checked by `expect` and named after its file stem when it has no name. */
function defaultExports<T>(dir: WorkerAgentDir, modules: readonly ToolModule[] | undefined): Array<{ file: string; stem: string; value: T }> {
  return (modules ?? []).map(({ file, module }) => ({ file: `${dir.name}/${file}`, stem: file.replace(/^.*\//, '').replace(STEM, ''), value: module.default as T }));
}

/** The `schedules/` schedules: same rules as `loadSchedules()` (a `defineSchedule()` default export, file-name stem as name). */
function collectSchedules(dir: WorkerAgentDir): DefinedSchedule[] {
  return defaultExports<unknown>(dir, dir.scheduleModules).map(({ file, stem, value }) => {
    if (!isDefinedSchedule(value)) {
      throw new SDKError(`loadAgentDir: ${file}: the default export must be a defineSchedule() schedule, for example export default defineSchedule({ cron: '0 9 * * MON', prompt: 'Good morning' }).`, 'LOUSHO_SCHEDULE_INVALID');
    }
    return defineSchedule({ ...value, name: value.name ?? stem });
  });
}

/** The `channels/` channels: same rules as `loadChannels()` (a channel default export, file-name stem as name). */
function collectChannels(dir: WorkerAgentDir): Channel[] {
  return defaultExports<Channel>(dir, dir.channelModules).map(({ file, stem, value }) => {
    const channel = value as Partial<Channel> | null;
    if (typeof channel !== 'object' || channel === null || typeof channel.parse !== 'function' || typeof channel.reply !== 'function') {
      throw new SDKError(`loadAgentDir: ${file}: the default export must be a channel from defineChannel(), httpChannel(), slackChannel(), discordChannel(), telegramChannel(), githubChannel() or teamsChannel().`, 'LOUSHO_CHANNEL_INVALID');
    }
    return defineChannel({ ...channel, name: channel.name ?? stem } as Channel);
  });
}

/** The `memory/` slots: same rules as `loadMemory()` (a `defineMemory()` slot or its options, file-name stem as name). */
function collectMemory(dir: WorkerAgentDir): MemorySlot[] {
  return defaultExports<MemorySlot>(dir, dir.memoryModules).map(({ file, stem, value }) => {
    const slot = value as Partial<MemorySlot> | null;
    if (typeof slot !== 'object' || slot === null || slot.scope === undefined || typeof slot.provider !== 'object' || slot.provider === null) {
      throw new SDKError(`loadAgentDir: ${file}: the default export must be a memory slot from defineMemory(), or an object with a scope and a provider.`, 'LOUSHO_MEMORY_INVALID');
    }
    return defineMemory({ ...slot, name: slot.name ?? stem } as Parameters<typeof defineMemory>[0]);
  });
}

/** A sub-agent's `description`, which the parent model needs to decide when to delegate. */
function requireDescription(sub: WorkerSubagentDir, config: AgentDirConfig): string {
  if (config.description === undefined) {
    invalid(
      `the sub-agent directory '${sub.name}': a sub-agent needs a 'description' so the parent agent knows when to ` +
        'delegate to it. Add one to its config, e.g. agent.json: { "description": "Reviews pull requests" }.'
    );
  }
  return config.description;
}

/**
 * The `createAgent()` options `dir` describes. Throws LOUSHO_AGENT_DIR_INVALID
 * for what `resolveAgentDir()` would also reject (a bad config, no
 * instructions, a tool file without tools, duplicate tool names, a sub-agent
 * without a description) and LOUSHO_DEPLOY_FAILED for what only the Worker
 * cannot do (no model, an unsupported provider, `projectInstructions`
 * options a code config kept from the build). `inherited` is the parent's
 * model for a `subagents/<name>/` resolution (undefined at the top level).
 */
export function resolveWorkerAgentDir(dir: WorkerAgentDir, inherited?: WorkerAgentModel): ResolvedWorkerAgentDir {
  const config = readDirConfig(dir);
  const model = chooseModel(dir, config, inherited);
  return {
    name: config.name ?? dir.name,
    instructions: chooseInstructions(dir, config) + projectInstructionsBlock(dir, config),
    model,
    tools: collectTools(dir.toolModules).map((loaded) => loaded.tool),
    skills: dir.skills,
    ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config.toolConcurrency === undefined ? {} : { toolConcurrency: config.toolConcurrency }),
    schedules: collectSchedules(dir),
    channels: collectChannels(dir),
    memory: collectMemory(dir),
    subagents: (dir.subagents ?? []).map((sub) => ({ name: sub.name, description: requireDescription(sub, readDirConfig(sub.dir)), dir: resolveWorkerAgentDir(sub.dir, model) })),
  };
}
