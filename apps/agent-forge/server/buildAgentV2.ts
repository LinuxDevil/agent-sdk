/**
 * buildRunnableAgent: turns an `AgentSpecV2` into a ready `SimpleAgent`
 * through the SDK's spec-v2 compiler (`compileSpec` — the config half of
 * `specV2ToAgent`, see src/spec/v2/specToAgent.ts), so everything the spec
 * declares (permissions, guardrails, MCP servers, skills, memory,
 * subagents, limits, hooks) is applied, while Studio still supplies its
 * stored provider keys, named secrets, checkpoint/approval stores, trace
 * exporter and the `demo-approval` local tool.
 *
 * Differences from the SDK's own `specV2ToAgent(spec, host)`:
 *  - `config.provider` is overridden with `resolveProviderForModel`, so a
 *    run uses the keys saved in Settings > Provider keys before the
 *    process environment (the SDK's own providerFor() is env-only).
 *  - Approvals go through `scopedApprovalStore`: the SDK writes
 *    `pending.agentId` it derives itself, but Studio's FileApprovalStore
 *    layout is `<base>/.lousho/agents/<agentId>/approvals/<id>.json`, so
 *    every pause is filed under the workspace agent id Studio knows.
 *  - The ticket's planned `host.localTools` field does not exist on the
 *    merged `SpecHost` (S16 landed `baseDir`/`resolveSecret`/`exporter`/
 *    `store` only). `LOCAL_TOOLS` are therefore merged into the compiled
 *    `config.tools` record — but only when the spec's `tools` names one
 *    (`{ registry: 'demo-approval' }` is what the v1 bridge stores for a
 *    Studio-local name; `{ builtin: 'demo-approval' }` is tolerated for
 *    hand-written specs). That keeps the v1 behaviour exactly: the tool is
 *    model-facing only for specs that ask for it, and the ref is stripped
 *    before compileSpec's resolver can reject it as an uninstalled
 *    registry tool.
 *
 * `compileSpec` takes the spec as already validated (the routes validate
 * body specs and `AgentRepo.writeSpec` validates stored ones), so this
 * does not re-validate: an invalid spec fails inside a section resolver
 * with the SDK's own LOUSHO_SPEC_* error.
 */
import * as path from 'node:path';
import {
  compileSpec,
  createAgent,
  type AgentEvent,
  type AgentHook,
  type AgentSpecV2,
  type ApprovalStore,
  type CheckpointStore,
  type SimpleAgent,
  type SpecHost,
  type ToolDescriptor,
  type TraceExporter,
} from 'lousho';
import type { AgentFlow } from 'lousho/flows';
import { LOCAL_TOOLS, resolveProviderForModel } from './buildAgent';
import type { FileApprovalStore } from './approvalStore';
import { isSecretProvider, PROVIDER_KEY_ENV, type SecretsStore } from './secretsStore';

/**
 * What a Studio workspace hands `buildRunnableAgent`: the workspace root
 * and the file-backed stores the run persists through. `baseDir` is the
 * workspace root (`WorkspaceRef.root`); agent-relative spec files
 * (`instructions.file`, `{ file }` tool/hook/skill refs) resolve under
 * `<baseDir>/.lousho/agents`, matching where AgentRepo keeps the working
 * copies. `secretsStore` is the Studio-global one (WorkspaceServices).
 */
export interface StudioRunDeps {
  baseDir: string;
  checkpointStore: CheckpointStore;
  approvalStore: FileApprovalStore;
  secretsStore?: SecretsStore;
}

/** The per-run wiring that is not part of the spec: event sink, trace exporter and Studio-appended hooks. */
export interface RunWiring {
  onEvent: (event: AgentEvent) => void;
  exporter: TraceExporter;
  captureContent?: boolean;
  /** Appended after the spec's own hooks (the step-debugger's `agentHooks()`). */
  extraHooks?: readonly AgentHook[];
}

/** What `buildRunnableAgent` returns: the built agent plus the side data RunManager/the status payload need. */
export interface RunnableAgent {
  agent: SimpleAgent;
  /** `spec.flow` when present - a flow spec runs through the legacy FlowExecutor path (RunManager.startFlowRun), never `agent.stream()`. */
  flow?: AgentFlow;
  /** `<provider>/<model>` the run actually uses, for the status payload's `provider` field, e.g. 'mock/mock-1'. */
  modelLabel: string;
}

/**
 * An `ApprovalStore` view over `store` that files every pause under
 * `agentId`, whatever `pending.agentId` the SDK set. Without it a pause a
 * spec run makes would land under `.lousho/agents/<sdk-derived-id>/` -
 * somewhere `peek(agentId, id)` (the pending-approval card) and
 * `resolveFor(agentId, id)` (approve()) never look.
 */
export function scopedApprovalStore(store: FileApprovalStore, agentId: string): ApprovalStore {
  return {
    save: (pending, snapshot) => store.save({ ...pending, agentId }, snapshot),
    resolve: (id) => store.resolveFor(agentId, id),
    load: (id) => store.peek(agentId, id),
  };
}

/** `spec.flow`, lenient like buildAgent.ts's `extractFlowFromSpec` (the v2 `flow` key is a pending section typed `never`, so it is read as data). */
function flowOf(spec: AgentSpecV2): AgentFlow | undefined {
  const raw = (spec as { flow?: unknown }).flow;
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<AgentFlow>;
  if (typeof candidate.code !== 'string' || typeof candidate.name !== 'string' || !candidate.flow) {
    return undefined;
  }
  return candidate as AgentFlow;
}

/** A `tools` entry's name when it is a `{ builtin }`/`{ registry }` ref naming a Studio-local tool (LOCAL_TOOLS key), else undefined. */
function localToolName(ref: unknown): string | undefined {
  if (typeof ref !== 'object' || ref === null) return undefined;
  const named = ref as { builtin?: unknown; registry?: unknown };
  if (typeof named.builtin === 'string' && named.builtin in LOCAL_TOOLS) return named.builtin;
  if (typeof named.registry === 'string' && named.registry in LOCAL_TOOLS) return named.registry;
  return undefined;
}

/**
 * Splits `spec.tools` into the refs compileSpec may see and the ones
 * naming Studio-local tools: the latter are stripped from the spec handed
 * to the compiler (its `{ builtin }` allow-list and `{ registry }` install
 * receipts both reject a Studio-local name) and returned as the
 * `ToolDescriptor`s to merge into `config.tools` afterwards.
 */
function splitLocalTools(spec: AgentSpecV2): { spec: AgentSpecV2; localTools: Record<string, ToolDescriptor> } {
  const refs = spec.tools ?? [];
  const names = new Set(refs.map(localToolName).filter((name): name is string => name !== undefined));
  if (names.size === 0) return { spec, localTools: {} };
  const kept = refs.filter((ref) => localToolName(ref) === undefined);
  const stripped = { ...spec, tools: kept.length > 0 ? kept : undefined } as AgentSpecV2;
  const localTools = Object.fromEntries([...names].map((name) => [name, LOCAL_TOOLS[name]]));
  return { spec: stripped, localTools };
}

/** `config.tools` as a mutable record (compileSpec only ever returns the record form; a function form is left alone). */
function mergeLocalTools(configTools: unknown, localTools: Record<string, ToolDescriptor>): unknown {
  const base =
    typeof configTools === 'object' && configTools !== null && !Array.isArray(configTools)
      ? (configTools as Record<string, ToolDescriptor>)
      : {};
  return { ...base, ...localTools };
}

/**
 * Compiles `spec` into a ready `SimpleAgent` (see the file doc comment).
 * The spec is taken as already validated; a build problem (unknown tool
 * ref, missing secret, unusable provider) rejects with the SDK's or
 * `resolveProviderForModel`'s ConfigurationError and no run is started.
 */
export async function buildRunnableAgent(
  spec: AgentSpecV2,
  agentId: string,
  deps: StudioRunDeps,
  wiring: RunWiring
): Promise<RunnableAgent> {
  const approvals = scopedApprovalStore(deps.approvalStore, agentId);
  const host: SpecHost = {
    baseDir: path.join(deps.baseDir, '.lousho', 'agents'),
    resolveSecret: (name) => deps.secretsStore?.getSecret(name),
    exporter: wiring.exporter,
    store: { checkpoints: deps.checkpointStore, approvals },
  };

  const { spec: compilable, localTools } = splitLocalTools(spec);
  // Resolve Studio's provider FIRST: this throws the actionable
  // `LOUSHO_PROVIDER_MISSING_API_KEY` before the compile does anything.
  const provider = resolveProviderForModel(spec.model, deps.secretsStore);
  // Studio's stored keys are invisible to the SDK's env-only provider
  // resolution inside compileSpec, so the stored key is seeded into its
  // env var just for the compile (restored in finally). The REAL
  // `spec.model` must stay on the spec being compiled: the compiler reads
  // it for more than the provider - e.g. `instructionsByFamily` (a spec
  // whose model is 'anthropic/claude-x' gets the 'claude' tail; a
  // stand-in model would drop or mis-pick it).
  const providerType = spec.model.slice(0, spec.model.indexOf('/')).toLowerCase();
  let envVar: string | undefined;
  let seeded = false;
  if (isSecretProvider(providerType)) {
    envVar = PROVIDER_KEY_ENV[providerType];
    const stored = process.env[envVar] === undefined ? deps.secretsStore?.getKey(providerType) : undefined;
    if (stored !== undefined) {
      process.env[envVar] = stored;
      seeded = true;
    }
  }
  let config;
  try {
    ({ config } = await compileSpec(compilable, host));
  } finally {
    if (seeded && envVar !== undefined) delete process.env[envVar];
  }
  // The compiled provider is Studio's (stored keys over env); `model` keeps
  // the spec's string for reporting/fallbacks (a provider INSTANCE wins
  // over `model` in createAgent's resolveModelSource).
  config.provider = provider;
  config.model = spec.model;
  if (Object.keys(localTools).length > 0) {
    config.tools = mergeLocalTools(config.tools, localTools) as typeof config.tools;
  }
  config.onEvent = wiring.onEvent;
  if (wiring.captureContent !== undefined) config.captureContent = wiring.captureContent;
  config.approvalStore = approvals;
  if (wiring.extraHooks !== undefined && wiring.extraHooks.length > 0) {
    config.hooks = [...(config.hooks ?? []), ...wiring.extraHooks];
  }

  const slash = spec.model.indexOf('/');
  return {
    agent: createAgent(config),
    flow: flowOf(spec),
    modelLabel: `${provider.name}/${spec.model.slice(slash + 1)}`,
  };
}
