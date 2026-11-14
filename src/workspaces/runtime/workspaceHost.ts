import type { TraceExporter } from '../../execution/tracing';
import type { MemorySlot } from '../../memory/defineMemory';
import type { LLMProvider } from '../../providers';
import type { SecretRef } from '../../spec/v2/secrets';
import type { ToolDescriptor } from '../../types';
import { SDKError } from '../../utils/sdkError';
import { secretKey, type PolicyCeiling } from '../contracts/policy';
import type { GlobalAgentRegistry } from './agentRegistry';
import type { ArtifactStore } from './artifacts';
import type { WorkspaceCheckRegistry } from './checks';
import type { EngineRegistry, PageRuntimeHost, PageToolScope } from './engines/types';
import type { HostToolRegistry } from './policy';
import type { ProfileStore } from './profileStore';
import type { SharedMemoryFile } from './sharedContext';
import type { WorkspaceCheckpointStore, WorkspaceRunEvents, WorkspaceRunStore, WorkspaceThreadStore } from './stores';

/** Reads secret values for the host's tools; a tool gets a resolver that answers only the secrets the policy granted it. */
export interface SecretResolver {
  /** The secret's value, or `undefined` when the host has none or the tool was not granted it. */
  resolve(ref: SecretRef): Promise<string | undefined>;
}

/** Turns a resolved model string into a provider; the only way a workspace model reaches a vendor. */
export interface ProviderResolver {
  /** The provider for a model such as `openai/gpt-4o-mini`; throw to refuse a model the host does not allow. */
  resolve(ref: string): LLMProvider;
}

/** The stores one workspace's runtime reads and writes, bound to that workspace. */
export interface WorkspaceRuntimeStores {
  /** Where page runs put their artifacts. */
  artifacts: ArtifactStore;
  /** The main agent's thread transcripts, by thread id. */
  threads: WorkspaceThreadStore;
  /** Run rows, each stamped with the revision it ran on. */
  runs: WorkspaceRunStore;
  /** Run checkpoints. */
  checkpoints: WorkspaceCheckpointStore;
  /** Run event logs; without it events reach only the caller. */
  events?: WorkspaceRunEvents;
}

/** Global agents and harness profiles, resolved by the host instead of a `LOUSHO_WORKSPACE` lookup. */
export interface WorkspaceGlobals {
  /** Answers `global:` agent refs. */
  agents: GlobalAgentRegistry;
  /** Answers `global:` harness profile refs. */
  profiles: ProfileStore;
}

/** Wraps one tool for one attachment so it reads only `scope.secrets` (through `secrets`), reaches only `scope.network.allowHosts`, and runs sandboxed when `scope.sandbox.required`. */
export type ToolBinder = (descriptor: ToolDescriptor, scope: PageToolScope, secrets: SecretResolver) => ToolDescriptor;

/** Everything environmental a workspace runtime gets from its host; the runtime reaches for nothing else. */
export interface WorkspaceHost {
  /** The host's tools by name; an agent's `tools/<name>.*` file names the host tool `<name>`. */
  tools: HostToolRegistry;
  /** The most the host allows; `shared/policies/policy.json` can only narrow it. */
  policyCeiling: PolicyCeiling;
  /** Providers for resolved model strings. */
  providers: ProviderResolver;
  /** Secret values, handed to each tool's binder scoped to that tool. */
  secrets: SecretResolver;
  /** The workspace's stores. */
  stores: WorkspaceRuntimeStores;
  /** Global agent and profile resolution. */
  globals: WorkspaceGlobals;
  /** Runtime limits. */
  limits?: {
    /** Workspace and direct page runs executing at once; more wait their turn. Default unlimited. */
    maxConcurrentRuns?: number;
  };
  /** Enforces each tool's secrets, network hosts and sandbox; without it only tools whose scope grants no secrets, no hosts and no sandbox can run, and any other tool fails the run. */
  bindTool?: ToolBinder;
  /** Programmatic checks by name, for criteria whose `check` names one; no runtime path runs criteria yet, the goal engine (P3.6) and check runs (P5.13) read it. */
  checks?: WorkspaceCheckRegistry;
  /** Builds the slot for a `shared/memory/*.ts` file; workspace code never runs. */
  createMemory?: (file: SharedMemoryFile) => MemorySlot;
  /** Receives every agent's spans. */
  exporter?: TraceExporter;
  /** Engines by execution type; defaults to `ENGINES`. */
  engines?: EngineRegistry;
  /** Makes run ids; defaults to a random UUID. */
  newRunId?: () => string;
}

const REQUIRED: readonly (readonly string[])[] = [
  ['tools'],
  ['policyCeiling'],
  ['providers'],
  ['providers', 'resolve'],
  ['secrets'],
  ['secrets', 'resolve'],
  ['stores'],
  ['stores', 'artifacts'],
  ['stores', 'threads'],
  ['stores', 'runs'],
  ['stores', 'checkpoints'],
  ['globals'],
  ['globals', 'agents'],
  ['globals', 'profiles'],
];

function at(host: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), host);
}

function hostError(message: string): SDKError {
  return new SDKError(`createWorkspaceRuntime: ${message}`, 'LOUSHO_WORKSPACE_HOST_INVALID');
}

export function checkHost(host: WorkspaceHost | undefined): WorkspaceHost {
  if (typeof host !== 'object' || host === null) throw hostError('the host is missing');
  for (const path of REQUIRED) {
    const value = at(host, path);
    if (value === undefined || value === null) throw hostError(`host.${path.join('.')} is missing`);
  }
  const max = host.limits?.maxConcurrentRuns;
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) throw hostError(`host.limits.maxConcurrentRuns must be a positive integer, got ${max}`);
  return host;
}

function scopedSecrets(secrets: SecretResolver, scope: PageToolScope): SecretResolver {
  const granted = new Set(scope.secrets.map(secretKey));
  return { resolve: async (ref) => (granted.has(secretKey(ref)) ? secrets.resolve(ref) : undefined) };
}

function unenforced(scope: PageToolScope): string | undefined {
  if (scope.sandbox.required) return 'must run sandboxed';
  if (scope.secrets.length > 0) return 'is granted secrets';
  return scope.network.allowHosts.length > 0 ? 'is limited to network hosts' : undefined;
}

function unboundTool(descriptor: ToolDescriptor, scope: PageToolScope): ToolDescriptor {
  const need = unenforced(scope);
  if (need !== undefined) throw hostError(`tool '${scope.name}' on '${scope.page}' ${need}, and the host gave no bindTool to enforce it`);
  return descriptor;
}

function modelOf(model: string | undefined): string {
  if (model === undefined) {
    throw new SDKError('A workspace agent has no model: set the attachment model, the page defaults.model, the agent model or the workspace defaults.model.', 'LOUSHO_CONFIG_MISSING_PROVIDER');
  }
  return model;
}

export function pageHostOf(host: WorkspaceHost): PageRuntimeHost {
  const bind = host.bindTool;
  return {
    tools: host.tools,
    ceiling: host.policyCeiling,
    bindTool: (descriptor, scope) => (bind ? bind(descriptor, scope, scopedSecrets(host.secrets, scope)) : unboundTool(descriptor, scope)),
    provider: (model) => host.providers.resolve(modelOf(model)),
    globalAgents: host.globals.agents,
    globalProfiles: host.globals.profiles,
    ...(host.exporter && { exporter: host.exporter }),
    ...(host.createMemory && { createMemory: host.createMemory }),
    ...(host.checks && { checks: host.checks }),
  };
}
