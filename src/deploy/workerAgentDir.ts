/**
 * An agent directory inside a Cloudflare Worker bundle (M3b).
 *
 * `resolveAgentDir()` reads the directory from disk and imports its files at
 * run time; a Worker has neither a file system nor dynamic `import()` of
 * arbitrary paths. So `lousho build --target=cloudflare-worker` reads the
 * directory on Node at build time and generates `agent.module.ts`: static
 * imports of the tool files (and of an `agent.ts` / `agent.js` config), and
 * the instructions, a JSON/YAML config and the skills embedded as JSON. This
 * module turns that {@link WorkerAgentDir} into `createAgent()` options with the
 * same rules as `resolveAgentDir()` (config validation, tool collection), plus
 * what the Worker target cannot do. Node-free: it runs inside the Worker.
 */
import { collectTools, type ToolModule } from '../agentDir/collectTools';
import { validateConfig, type AgentDirConfig } from '../agentDir/validateConfig';
import type { DefinedTool } from '../tools/defineTool';
import type { Skill } from '../skills/defineSkill';
import type { LLMProvider } from '../providers/llm';
import type { ToolConcurrency } from '../execution/toolBatch';
import { SDKError } from '../execution/errors';
import { WORKER_SUPPORTED_PROVIDERS } from './workerSupport';

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
}

/** The model of a Worker agent: a provider instance from `agent.ts`, or a provider type to create with the Worker's API key binding. */
export type WorkerAgentModel =
  | { provider: LLMProvider; model?: string }
  | { providerType: string; model: string };

/** The `createAgent()` options of a {@link WorkerAgentDir}, minus what needs the Worker's `env`. */
export interface ResolvedWorkerAgentDir {
  name: string;
  instructions: string;
  model: WorkerAgentModel;
  tools: DefinedTool[];
  skills: readonly Skill[];
  maxSteps?: number;
  toolConcurrency?: ToolConcurrency;
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

/** Same precedence as `resolveAgentDir()`: a provider instance wins and drops a `provider/model` string; otherwise the string names a Worker provider. */
function chooseModel(dir: WorkerAgentDir, config: AgentDirConfig): WorkerAgentModel {
  const where = dir.configFile ?? `the agent directory '${dir.name}'`;
  if (config.provider) {
    const model = config.model && !config.model.includes('/') ? config.model : undefined;
    return model === undefined ? { provider: config.provider } : { provider: config.provider, model };
  }
  if (config.model === undefined) {
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

/**
 * The `createAgent()` options `dir` describes. Throws LOUSHO_AGENT_DIR_INVALID
 * for what `resolveAgentDir()` would also reject (a bad config, no
 * instructions, a tool file without tools, duplicate tool names) and
 * LOUSHO_DEPLOY_FAILED for what only the Worker cannot do (no model,
 * an unsupported provider, `projectInstructions`).
 */
export function resolveWorkerAgentDir(dir: WorkerAgentDir): ResolvedWorkerAgentDir {
  const config = readDirConfig(dir);
  if (config.projectInstructions) {
    unsupported(`${dir.configFile} sets 'projectInstructions', which reads AGENTS.md / CLAUDE.md from a file system a Worker does not have. Remove it, or paste what you need into instructions.md.`);
  }
  return {
    name: config.name ?? dir.name,
    instructions: chooseInstructions(dir, config),
    model: chooseModel(dir, config),
    tools: collectTools(dir.toolModules).map((loaded) => loaded.tool),
    skills: dir.skills,
    ...(config.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config.toolConcurrency === undefined ? {} : { toolConcurrency: config.toolConcurrency }),
  };
}
