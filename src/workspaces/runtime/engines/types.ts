import type { LLMProvider } from '../../../providers';
import type { ToolDescriptor } from '../../../types';
import type { SecretRef } from '../../../spec/v2/secrets';
import type { EffectiveHarness } from '../../contracts/compose';
import type { PageEngine, PageResult } from '../../contracts/execution';
import type { PageManifest, WorkType } from '../../contracts/page';
import type { PolicyCeiling } from '../../contracts/policy';
import type { GlobalAgentRegistry } from '../agentRegistry';
import type { LoadedWorkspace } from '../loadWorkspace';
import type { AgentPolicyOptions, HostToolRegistry } from '../policy';
import type { ProfileStore } from '../profileStore';
import type { ResolvedAttachment } from '../resolveAgents';
import type { SharedContext, SharedMemoryFile } from '../sharedContext';
import type { MemorySlot } from '../../../memory/defineMemory';

/** What the policy lets one tool of one attachment do; the host's `bindTool` enforces it. */
export interface PageToolScope {
  /** The tool name. */
  name: string;
  /** The page the tool runs on. */
  page: string;
  /** The attachment alias whose agent calls the tool. */
  attachment: string;
  /** The only secrets the tool may read. */
  secrets: SecretRef[];
  /** Outbound hosts the tool may reach. */
  network: {
    /** Allowed hosts. */
    allowHosts: string[];
  };
  /** Execution isolation. */
  sandbox: {
    /** Whether the tool must run sandboxed. */
    required: boolean;
  };
}

/** What the host injects into the page runtime: tools, the policy ceiling, providers and global resolution. */
export interface PageRuntimeHost {
  /** The host's tools by name; an agent's `tools/<name>.*` file names the host tool `<name>`. */
  tools: HostToolRegistry;
  /** The host's policy ceiling, narrowed by `shared/policies/policy.json`. */
  ceiling: PolicyCeiling;
  /** Wraps every tool an agent gets so it reads only `scope.secrets`, reaches only `scope.network.allowHosts`, and runs sandboxed when `scope.sandbox.required`. */
  bindTool(descriptor: ToolDescriptor, scope: PageToolScope): ToolDescriptor;
  /** The provider for an attachment's resolved model; without it `createAgent` resolves the model string itself. */
  provider?: (model: string | undefined) => LLMProvider;
  /** Answers `global:` agent refs. */
  globalAgents?: GlobalAgentRegistry;
  /** Answers `global:` harness profile refs. */
  globalProfiles?: ProfileStore;
  /** Builds the slot for a `shared/memory/*.ts` file; the core never runs workspace code. */
  createMemory?: (file: SharedMemoryFile) => MemorySlot;
}

/** One attachment of the page, resolved, with the policy applied. */
export interface PageAttachment {
  /** The agent as resolved from `agents.json`. */
  resolved: ResolvedAttachment;
  /** The tools, permissions, secrets, network and sandbox the policy gives it. */
  policy: AgentPolicyOptions;
}

/** Everything an engine needs to run one page: built by `runPage` before the engine starts. */
export interface PageEngineSetup {
  /** The loaded workspace. */
  workspace: LoadedWorkspace;
  /** The page's `page.json`. */
  page: PageManifest;
  /** The page's effective harness. */
  harness: EffectiveHarness;
  /** The shared layer for this page. */
  shared: SharedContext;
  /** The page's attachments by alias. */
  attachments: Readonly<Record<string, PageAttachment>>;
  /** The host. */
  host: PageRuntimeHost;
  /** The earlier run a revise works on; a page sees only its result, never its transcript. */
  prior?: PageResult;
}

/** Builds the engine for one page run. */
export type PageEngineFactory = (setup: PageEngineSetup) => PageEngine;

/** Engine factories by execution type. */
export type EngineRegistry = Readonly<Partial<Record<WorkType, PageEngineFactory>>>;
