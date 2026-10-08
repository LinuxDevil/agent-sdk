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
import { isDirectory, isFile, listSorted, readText } from './fsUtil';
import type { DefinedSchedule } from '../schedules/defineSchedule';
import type { Channel } from '../channels/defineChannel';
import { loadChannels } from './loadChannels';
import { loadMemory, mergeMemory } from './loadMemory';
import type { MemorySlot } from '../memory/defineMemory';
import { loadSchedules } from './loadSchedules';
import { loadTools, type LoadedTool } from './loadTools';
import { confineToolsToReceipt, deferEnforcedApprovals, registryWarnings, verifyReceipt, type RegistryStatus } from './registryEnforce';
import { readConfig, type AgentDirConfig } from './readConfig';
import { fail, permissionRulesOf } from './validateConfig';
import { delegateTool, listSubagentDirs, requireDescription, type LoadedSubagent } from './subagents';
import { piAgent, type PiAgentOptions } from '../subagents/piAgent';
import type { RemoteSubagent } from '../subagents/types';
import { SDKError } from '../execution/errors';
import type { AuthFn } from '../auth/types';
import type { AgentHook } from '../execution/hooks';
import type { ApproveToolCall } from '../createAgentApprovals';
import type { AgentStore } from '../storage/agentStore';
import { fileStore } from '../storage/fileStore';
import { loadAuth } from './loadAuth';
import { importModule } from './importModule';

export type { AgentDirConfig } from './readConfig';
export type { Attestation, RegistryItemStatus, RegistryStatus } from './registryEnforce';

/**
 * Options that win over what the directory's files say. Same shape as
 * `createAgent()`'s options, plus `piAgent` for the `engine: 'pi'` sub-agent
 * directories; `tools` and `skills` replace the discovered ones
 * (they are not merged). A `subagents` override replaces the discovered
 * `subagents/` directories (their `delegate_to_<name>` tools are not added and
 * their files are not even loaded). `memory` is merged with the directory's `memory/` slots by name; the override wins a clash.
 * `approve` and `hooks` also accept `null`: it strips the directory's wiring
 * (the file the config names is not even imported and the assembled config
 * omits the option), where `undefined` keeps the directory's.
 *
 * @example
 * ```ts
 * const agent = await loadAgentDir('./my-agent', { provider: mockModel(['hi']) });
 * ```
 */
export type AgentDirOverrides = Omit<CreateAgentConfig, 'approve' | 'hooks'> & {
  /**
   * The approver override; `null` strips the directory's `approve` (its file
   * is not imported, the assembled config has no `approve`), `undefined`
   * keeps it.
   */
  approve?: ApproveToolCall | null;
  /** The hooks override; `null` strips the directory's `hooks` like `approve` above. */
  hooks?: readonly AgentHook[] | null;
  /**
   * Options merged into every `engine: 'pi'` sub-agent the directory declares
   * (`subagents/<name>/` whose config sets `"engine": "pi"`). Use it to inject
   * a `modelRuntime` (e.g. pi-ai's faux provider in tests), `sessionDir`,
   * `agentDir`, `tools`, `thinkingLevel`, or to replace the config's `model`
   * and `permissions`. The directory always wins `cwd` (its install dir),
   * `name` and `description`.
   */
  piAgent?: Partial<PiAgentOptions>;
};

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

const MARKDOWN = /\.md$/i;

/**
 * The `instructions/<family>.md` file that matches `modelId`, or undefined:
 * files are read sorted and the first whose stem (e.g. `openai`,
 * `anthropic`) is contained in the model id wins, like the per-family
 * instruction tails coding harnesses keep. An empty file is an error.
 */
async function familyInstructionsFor(dir: string, modelId: string): Promise<{ file: string; text: string } | undefined> {
  const instructionsDir = path.join(dir, 'instructions');
  for (const name of await listSorted(instructionsDir, (e) => e.isFile && MARKDOWN.test(e.name))) {
    const stem = name.replace(MARKDOWN, '');
    if (stem !== '' && modelId.includes(stem)) {
      const file = path.join(instructionsDir, name);
      const text = (await readText(file)).trim();
      if (text === '') throw new SDKError(`loadAgentDir: ${file} is empty. Write the family-specific prompt tail in it or remove the file.`, 'LOUSHO_AGENT_DIR_INVALID');
      return { file, text };
    }
  }
  return undefined;
}

/** Extensions of a config-pointed code file and their compiled siblings (`.ts` -> `.js`, `.mts` -> `.mjs`, `.cts` -> `.cjs`). */
const COMPILED_SIBLING: Record<string, string> = { '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs' };

/**
 * A config-named path (`hooks`, `approve`, `store.dir`): `rel` must be
 * relative and stay inside `dir`; returns the resolved absolute path
 * (existence is the caller's check).
 */
function configRelativePath(dir: string, key: string, rel: string, configFile: string | undefined): string {
  const where = configFile ?? dir;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) {
    fail(where, `'${key}' must be a path relative to the agent directory (forward slashes), got '${rel}'.`);
  }
  const resolved = path.resolve(dir, rel);
  const inside = path.relative(dir, resolved);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    fail(where, `'${key}' path '${rel}' must stay inside the agent directory.`);
  }
  return resolved;
}

/**
 * The file a config path (`hooks`, `approve`) names. When the exact file is
 * absent but its compiled sibling exists (a bundled `dist/agent` has `.js`
 * where the source had `.ts`), the sibling is used.
 */
async function configuredFile(dir: string, key: string, rel: string, configFile: string | undefined): Promise<string> {
  const resolved = configRelativePath(dir, key, rel, configFile);
  if (await isFile(resolved)) return resolved;
  const ext = path.extname(resolved);
  const sibling = COMPILED_SIBLING[ext] === undefined ? undefined : `${resolved.slice(0, -ext.length)}${COMPILED_SIBLING[ext]}`;
  if (sibling !== undefined && (await isFile(sibling))) return sibling;
  fail(configFile ?? dir, `'${key}' points at '${rel}', which does not exist in ${dir}.`);
}

/**
 * The config's `store`: `{ "dir": "..." }` becomes a `fileStore()` rooted
 * inside the agent directory (sessions, checkpoints and paused approvals that
 * survive a restart); a code config may give an `AgentStore` instance, passed
 * through as-is. The `dir` need not exist yet - `fileStore()` creates it on
 * the first write.
 */
function configuredStore(dir: string, config: AgentDirConfig, configFile: string | undefined): AgentStore | undefined {
  const value = config.store;
  if (value === undefined) return undefined;
  if (!('dir' in value)) return value;
  return fileStore(configRelativePath(dir, 'store.dir', value.dir, configFile), {
    ...(value.historyLimit !== undefined && { historyLimit: value.historyLimit }),
    ...(value.tokenKey !== undefined && { tokenKey: value.tokenKey }),
  });
}

/** The config's `hooks`: inline hook(s), or the default export of the file `hooks` points at (a hook or a list of them). */
async function configuredHooks(
  dir: string,
  config: AgentDirConfig,
  configFile: string | undefined
): Promise<{ hooks: readonly AgentHook[]; file?: string } | undefined> {
  const value = config.hooks;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return { hooks: Array.isArray(value) ? value : [value] };
  const file = await configuredFile(dir, 'hooks', value, configFile);
  const exported = (await importModule(file)).default;
  const hooks = Array.isArray(exported) ? exported : [exported];
  if (hooks.length === 0 || !hooks.every((hook) => typeof hook === 'object' && hook !== null && typeof (hook as AgentHook).name === 'string')) {
    throw new SDKError(`loadAgentDir: ${file}: the default export must be a hook ({ name, preToolCall, ... }) or a list of them.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  return { hooks: hooks as AgentHook[], file };
}

/** The config's `approve`: an inline function, or the default export (a function) of the file `approve` points at. */
async function configuredApprove(
  dir: string,
  config: AgentDirConfig,
  configFile: string | undefined
): Promise<{ approve: ApproveToolCall; file?: string } | undefined> {
  const value = config.approve;
  if (value === undefined) return undefined;
  if (typeof value === 'function') return { approve: value };
  const file = await configuredFile(dir, 'approve', value, configFile);
  const exported = (await importModule(file)).default;
  if (typeof exported !== 'function') {
    throw new SDKError(`loadAgentDir: ${file}: the default export must be an approver function, e.g. export default ({ args }) => true.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  return { approve: exported as ApproveToolCall, file };
}

/** The model id family instructions are matched on: the run's model string, else the provider's default model. */
function modelIdOf(source: Inherited): string | undefined {
  return typeof source.model === 'string' ? source.model : source.provider?.defaultModel;
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

interface LoadedSubagents {
  /** Nested `createAgent` sub-agents; each becomes a `delegate_to_<name>` tool. */
  delegated: LoadedSubagent[];
  /** `engine: 'pi'` sub-agents; each becomes an entry of the parent's `subagents` map (the `task` tool). */
  remote: Record<string, RemoteSubagent>;
  /** Every discovered sub-agent directory name, in order. */
  names: string[];
}

/**
 * The `engine: 'pi'` sub-agent of `subagents/<name>/`: a {@link piAgent}
 * bound to the parent's directory, which is the workspace its file tools
 * and the Pi session share. The config's `model` is an SDK model id
 * (`pi/<provider>/<model>`); the `pi/` prefix is stripped because Pi
 * resolves `provider/model` ids itself.
 */
function piSubagent(
  dir: string,
  name: string,
  childDir: string,
  configFile: string | undefined,
  config: AgentDirConfig,
  extra: Partial<PiAgentOptions> | undefined
): RemoteSubagent {
  const description = requireDescription(childDir, config.description);
  let model: string | undefined;
  if (config.model !== undefined) {
    if (!config.model.startsWith('pi/') || config.model.length === 'pi/'.length) {
      fail(
        configFile ?? childDir,
        `a 'engine': 'pi' sub-agent's 'model' must be a 'pi/<provider>/<model>' id ` +
          `(e.g. "pi/openrouter/openai/gpt-4o-mini"), got '${config.model}'.`
      );
    }
    model = config.model.slice('pi/'.length);
  }
  return piAgent(
    Object.assign(
      {
        cwd: dir,
        name,
        description,
        model,
        permissions: permissionRulesOf(configFile ?? childDir, config.permissions),
      },
      extra,
      // The install directory's workspace and identity always win over the injected options.
      { cwd: dir, name, description }
    )
  );
}

/**
 * What a sub-agent directory inherits about the install receipt: the receipt
 * of the directory it was installed with (a kit's `subagents/<name>/` files
 * are recorded in the kit's receipt at the kit root), and the approver the
 * host passed in code, the only one that may decide receipt-enforced calls.
 */
interface ReceiptScope {
  /** The nearest enclosing receipt and the directory its paths are relative to. */
  receipt?: { root: string; status: RegistryStatus };
  /** `loadAgentDir(dir, { approve })`: decides the enforced calls of every sub-agent too. */
  hostApprove?: ApproveToolCall;
}

async function loadSubagents(dir: string, overrides: AgentDirOverrides, inherited: Inherited, scope: ReceiptScope): Promise<LoadedSubagents> {
  const loaded: LoadedSubagents = { delegated: [], remote: {}, names: [] };
  const childOverrides: AgentDirOverrides = overrides.provider ? { provider: overrides.provider } : {};
  for (const name of await listSubagentDirs(dir)) {
    const childDir = path.join(dir, 'subagents', name);
    const { file: childConfigFile, config: childConfig } = await readConfig(childDir);
    loaded.names.push(name);
    if (childConfig.engine === 'pi') {
      loaded.remote[name] = piSubagent(dir, name, childDir, childConfigFile, childConfig, overrides.piAgent);
      continue;
    }
    const child = await resolveWith(childDir, childOverrides, inherited, scope);
    const description = requireDescription(childDir, child.manifest.description);
    loaded.delegated.push({ name, description, agent: createAgent(child.config) });
  }
  return loaded;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Base instructions plus the `instructions/<family>.md` tail when the resolved model id names a family. */
async function resolveInstructions(
  dir: string,
  config: AgentDirConfig,
  fromFile: { file: string; text: string } | undefined,
  overrides: AgentDirOverrides,
  source: Inherited
): Promise<{ instructions: unknown; familyFile?: string }> {
  const instructions = chooseInstructions(dir, config, fromFile, overrides);
  const overridden = overrides.instructions !== undefined || overrides.prompt !== undefined;
  if (overridden || typeof instructions !== 'string') return { instructions };
  const modelId = modelIdOf(source);
  const family = modelId === undefined ? undefined : await familyInstructionsFor(dir, modelId);
  return family ? { instructions: `${instructions}\n${family.text}`, familyFile: family.file } : { instructions };
}

/** The `createAgent()` options an agent directory resolves to: file config, discovered parts, then caller overrides. */
function assembleConfig(
  dir: string,
  configFile: string | undefined,
  config: AgentDirConfig,
  source: Inherited,
  parts: {
    name: string;
    instructions: unknown;
    tools: LoadedTool[];
    delegated: LoadedSubagent[];
    remote: Record<string, RemoteSubagent>;
    overrides: AgentDirOverrides;
    memorySlots: MemorySlot[];
    skills: Skill[];
    configured?: { hooks: readonly AgentHook[]; file?: string };
    approver?: { approve: ApproveToolCall; file?: string };
  }
): CreateAgentConfig {
  const { name, instructions, tools, delegated, remote, overrides, memorySlots, skills, configured, approver } = parts;
  const fileTools = [...tools.map((t) => t.tool), ...delegated.map(delegateTool)];
  const subagents = Object.keys(remote).length > 0 ? remote : undefined;
  // Every other createAgent() option the caller passed (guardrails, onEvent, retry, ...) is forwarded as is;
  // the keys below are resolved against the directory first. `piAgent` is not a createAgent() option.
  const { approve: _approve, hooks: _hooks, piAgent: _piAgent, prompt: _prompt, provider: _provider, model: _model, ...forwarded } = overrides;
  return {
    ...forwarded,
    name,
    instructions,
    ...optional('provider', source.provider),
    ...optional('model', source.model),
    // Discovered/directory-declared options (a caller override wins each).
    ...optional('tools', overrides.tools ?? (fileTools.length > 0 ? fileTools : undefined)),
    ...optional('memory', mergeMemory(memorySlots, overrides.memory)),
    ...optional('skills', overrides.skills ?? (skills.length > 0 ? skills : undefined)),
    ...optional('subagents', overrides.subagents ?? subagents),
    ...optional('maxSteps', overrides.maxSteps ?? config.maxSteps),
    ...optional('toolConcurrency', overrides.toolConcurrency ?? config.toolConcurrency),
    ...optional('projectInstructions', overrides.projectInstructions ?? config.projectInstructions),
    ...configOptions(dir, configFile, config, overrides, configured, approver),
    // Override-only options: no config key declares them.
    ...optional('approvalStore', overrides.approvalStore),
    ...optional('onPermissionDecision', overrides.onPermissionDecision),
    ...optional('exporter', overrides.exporter),
  } as CreateAgentConfig;
}

/** The config-file options (`permissionMode`, `permissions`, ..., `store`), each taking a caller override first. */
function configOptions(
  dir: string,
  configFile: string | undefined,
  config: AgentDirConfig,
  overrides: AgentDirOverrides,
  configured: { hooks: readonly AgentHook[]; file?: string } | undefined,
  approver: { approve: ApproveToolCall; file?: string } | undefined
): Partial<CreateAgentConfig> {
  return {
    ...optional('permissionMode', overrides.permissionMode ?? config.permissionMode),
    ...optional('permissions', overrides.permissions ?? permissionRulesOf(configFile ?? dir, config.permissions)),
    ...optional('compaction', overrides.compaction ?? config.compaction),
    ...optional('limits', overrides.limits ?? config.limits),
    ...optional('hooks', overrides.hooks ?? configured?.hooks),
    ...optional('approve', overrides.approve ?? approver?.approve),
    ...optional('approvalTtlMs', overrides.approvalTtlMs ?? config.approvalTtlMs),
    ...optional('store', overrides.store ?? configuredStore(dir, config, configFile)),
  };
}

async function resolveWith(
  rawDir: string,
  overrides: AgentDirOverrides,
  inherited: Inherited,
  parentScope: ReceiptScope = {}
): Promise<ResolvedAgentDir> {
  const dir = path.resolve(rawDir);
  if (!(await isDirectory(dir))) {
    throw new SDKError(`loadAgentDir: '${dir}' is not a directory. Pass the path of an agent directory.`, 'LOUSHO_AGENT_DIR_INVALID');
  }
  const { file: configFile, config } = await readConfig(dir);
  if (config.engine !== undefined) {
    fail(configFile ?? dir, `'engine' is only valid for a directory under 'subagents/' - the main agent has no engine.`);
  }
  const fromFile = await readInstructions(dir);
  const source = chooseModelSource(config, overrides, inherited);
  // instructions/<family>.md appends to the base prompt when the resolved model id contains a family name.
  const { instructions, familyFile } = await resolveInstructions(dir, config, fromFile, overrides, source);
  // Hooks/approver files are only imported when the caller did not override them.
  const configured = overrides.hooks === undefined ? await configuredHooks(dir, config, configFile) : undefined;
  const configuredApprover = overrides.approve === undefined ? await configuredApprove(dir, config, configFile) : undefined;
  // #272: verify the install receipt before its code runs, then bind its tools to the accepted manifests.
  const registry = await verifyReceipt(dir);
  for (const warning of registryWarnings(registry)) console.warn(`[lousho] ${warning}`);
  // A sub-agent directory without a receipt of its own is held to the receipt it was installed with.
  const scope: ReceiptScope = {
    receipt: registry === undefined ? parentScope.receipt : { root: dir, status: registry },
    hostApprove: parentScope.hostApprove ?? overrides.approve ?? undefined,
  };
  const tools: LoadedTool[] = confineToolsToReceipt(scope.receipt?.root ?? dir, await loadTools(dir), scope.receipt?.status);
  // The directory's own approver does not decide the calls the receipt makes wait for approval; in a
  // sub-agent, the host's in-code approver (not passed down as an override) decides them instead.
  const approver = directoryApprover(configuredApprover, tools, parentScope.hostApprove);
  const skills = await skillsFor(dir, overrides);
  const subagents =
    overrides.subagents === undefined ? await loadSubagents(dir, overrides, source, scope) : { delegated: [], remote: {}, names: [] };
  const schedules = await loadSchedules(dir);
  const channels = await loadChannels(dir);
  const memorySlots = await loadMemory(dir);
  const name = overrides.name ?? config.name ?? path.basename(dir);

  const assembled = assembleConfig(dir, configFile, config, source, {
    name,
    instructions,
    tools,
    delegated: subagents.delegated,
    remote: subagents.remote,
    overrides,
    memorySlots,
    skills,
    configured,
    approver,
  });

  const files = [...new Set([configFile, fromFile?.file, familyFile, configured?.file, approver?.file, ...tools.map((t) => t.file)])].filter(
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
      subagents: subagents.names,
      schedules: schedules.map((s) => s.name as string),
      channels: channels.map((c) => c.name),
      memory: memorySlots.map((m) => m.name),
      auth: false,
      ...optional('registry', registry),
    },
  };
}

/** The directory's approver with receipt-enforced calls taken out of its hands (see {@link deferEnforcedApprovals}). */
function directoryApprover(
  configured: { approve: ApproveToolCall; file?: string } | undefined,
  tools: LoadedTool[],
  hostApprove: ApproveToolCall | undefined
): { approve: ApproveToolCall; file?: string } | undefined {
  const approve = deferEnforcedApprovals(configured?.approve, tools, hostApprove);
  return approve === undefined ? undefined : { ...configured, approve };
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
 *   agent.ts | agent.js | agent.json | agent.yaml   config: model, description, maxSteps,
 *                                                    permissionMode, permissions, compaction,
 *                                                    hooks (path), approve (path), approvalTtlMs,
 *                                                    limits, store ({ "dir": "./.lousho" }), ...
 *   instructions.md                                  system prompt
 *   instructions/<family>.md                         appended when the model id contains <family>
 *   hooks.ts | approve.ts (or any path the config names)  a hooks / approver file the config points at
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
 * `provider` override is passed down to all of them. A sub-agent directory
 * whose config sets `"engine": "pi"` becomes a {@link piAgent} coding
 * sub-agent instead: it lands in the parent's `subagents` map (the `task`
 * tool), bound to the parent's directory as the workspace its sessions run
 * in - see `overrides.piAgent` for injecting a model runtime in tests.
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
