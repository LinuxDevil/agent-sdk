/**
 * Compiles an `AgentSpec` (the app's `graphToSpec()` output, or whatever a
 * saved agent's spec file holds) into the `{agent, provider, toolRegistry}`
 * triple `AgentExecutor.execute()` needs directly.
 *
 * `src/spec/specToAgent.ts`'s own `specToAgent()` does something similar,
 * but it returns a `SimpleAgent` (`{send(message)}`) that hides the
 * AgentConfig/provider/toolRegistry inside a closure and calls
 * `AgentExecutor.execute()` with no `sessionId`/`checkpointStore`/
 * `approvalStore`/`onAgentEvent`/abortable-provider hooks - exactly the things
 * this server needs to wire up N2/N3. So this file composes the same
 * public building blocks `specToAgent()` uses
 * (`resolveSpecProvider`/`resolveSpecTool`/`AgentBuilder`/`ToolRegistry`,
 * all public SDK exports) itself, rather than reaching past `specToAgent()`
 * into SDK internals.
 */
import { AgentBuilder, ToolRegistry } from '@lousho/build-ai-agent/executor';
import {
  ConfigurationError,
  NoopSandbox,
  SDKError,
  LLMProviderRegistry,
  resolveSpecProvider,
  resolveSpecTool,
  type AgentConfig,
  type AgentSpec,
  type HookRegistry,
  type LLMProvider,
  type SandboxAdapter,
  type ToolDescriptor,
} from '@lousho/build-ai-agent';
import type { AgentFlow } from '@lousho/build-ai-agent/flows';
import { compileHooksFromSpecPolicy } from './compileHooks';
import { isSecretProvider, type SecretsStore } from './secretsStore';

/**
 * Local, server-only tools available to a spec's `tools` list in ADDITION
 * to the core SDK's `resolveSpecTool()` built-ins (http/current-date/
 * day-name - see `src/spec/specToAgent.ts`), none of which set
 * `needsApproval`. Agent Forge's canvas "Tool call" node's "Tool name"
 * field (`Inspector.tsx`) is a free-text input, so typing one of these
 * names there and running the agent exercises the real human-in-the-loop
 * approval gate (`AgentExecutor` pausing on `needsApproval`, `RunManager`
 * persisting the pending approval, `POST /agents/:id/approve` resuming it)
 * end-to-end through the actual app - not just via a hand-built
 * `ToolDescriptor` in a server-side unit test the way
 * `server/__tests__/approvalFlow.test.ts` does it. This is deliberately
 * kept local to the Agent Forge server rather than added to the core SDK's
 * own built-in tools: it exists to make that flow demonstrable/testable in
 * the app, not as a tool anyone would want in a real deployed agent.
 */
const LOCAL_TOOLS: Record<string, ToolDescriptor> = {
  'demo-approval': {
    displayName: 'Demo approval-gated tool',
    tool: {
      description: 'A no-op tool that always requires human approval before running (for trying out the approval-gate flow in Agent Forge).',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => ({ done: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    needsApproval: true,
  },
};

function resolveAgentForgeTool(name: string): ToolDescriptor {
  if (LOCAL_TOOLS[name]) return LOCAL_TOOLS[name];
  return resolveSpecTool(name);
}

export interface BuiltAgent {
  agent: AgentConfig;
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  /**
   * LOU-Q1/Q2: compiled from `spec.policy.hooks` (the enabled hooks
   * attached to nodes in the canvas graph - see graphToSpec.ts), or
   * `undefined` when the agent has none. Each compiled hook runs its
   * user-authored code sandboxed via `sandbox` (see hookSandbox.ts) rather
   * than in this server process.
   */
  hooks?: HookRegistry;
  /** The SandboxAdapter both `hooks` and any `requiresSandbox` tool are routed through. */
  sandbox: SandboxAdapter;
}

const REAL_KEYED_PROVIDER_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Real provider types this app doesn't manage a stored key for (no plain-API-key concept, or not yet wired into secretsStore) - env-var-only. */
const REAL_ENV_ONLY_PROVIDERS = new Set(['ollama', 'openrouter']);

/**
 * Eve DUI-F4: a real provider with no usable credential. The studio used to
 * swap in the `mock` provider here and only say so in a log line, so a user
 * with no key got "This is a mock response." and thought the model answered.
 * The run now fails up front with this actionable error instead; `mock` is
 * still one click away as the agent's provider.
 */
function missingProviderKey(type: string, envVar: string): ConfigurationError {
  return new ConfigurationError(
    `No API key for provider '${type}'. Add one in Settings > Provider keys, set ${envVar} in the ` +
      "environment 'lousho studio' runs in, or switch this agent's provider to 'mock'.",
    'provider',
    'LOUSHO_PROVIDER_MISSING_API_KEY'
  );
}

/**
 * Resolves `spec.provider` to a real `LLMProvider`, preferring a stored key
 * from `secretsStore` (LOU-R1) over the env-var-only path
 * `resolveSpecProvider()` (the core SDK's `src/spec/specToAgent.ts`) uses.
 * A real provider type with no usable credential throws a
 * `LOUSHO_PROVIDER_MISSING_API_KEY` `ConfigurationError` (Eve DUI-F4) - it
 * never silently runs `mock` instead.
 */
function resolveProviderForSpec(type: string, model: string, secretsStore?: SecretsStore): LLMProvider {
  const lower = type.toLowerCase();

  if (isSecretProvider(lower)) {
    const storedKey = secretsStore?.getKey(lower);
    const key = storedKey || process.env[REAL_KEYED_PROVIDER_ENV[lower]];
    if (!key) throw missingProviderKey(lower, REAL_KEYED_PROVIDER_ENV[lower]);
    return LLMProviderRegistry.create(lower, { defaultModel: model, apiKey: key });
  }

  // ollama/openrouter: the env-var-driven SDK path. Its own error (e.g.
  // OPENROUTER_API_KEY unset) is passed on with a pointer to the fix.
  if (REAL_ENV_ONLY_PROVIDERS.has(lower)) {
    try {
      return resolveSpecProvider(type, model);
    } catch (error) {
      type Code = ConstructorParameters<typeof ConfigurationError>[2];
      const code = (error instanceof SDKError ? error.code : 'LOUSHO_CONFIG_INVALID') as Code;
      throw new ConfigurationError(
        `Provider '${lower}' is not usable: ${(error as Error).message} ` +
          "Fix its environment, or switch this agent's provider to 'mock'.",
        'provider',
        code
      );
    }
  }

  // 'mock', or any type this app doesn't recognize as a real provider at
  // all (a genuine config error, e.g. a typo'd provider name) - let this
  // throw exactly like it always has.
  return resolveSpecProvider(type, model);
}


export interface BuildAgentFromSpecOptions {
  /** LOU-R1: stored provider keys, checked before env vars. */
  secretsStore?: SecretsStore;
  /** LOU-R3: configurable sandboxed-hook timeout (settingsStore.ts's `SettingsProfile.hookTimeoutMs`). */
  hookTimeoutMs?: number;
}

export function buildAgentFromSpec(
  spec: AgentSpec,
  agentId: string,
  sandbox: SandboxAdapter = NoopSandbox,
  options: BuildAgentFromSpecOptions = {}
): BuiltAgent {
  const provider = resolveProviderForSpec(
    spec.provider.type,
    spec.provider.model,
    options.secretsStore
  );

  let toolRegistry: ToolRegistry | undefined;
  const toolsConfig: Record<string, { tool: string }> = {};
  for (const name of spec.tools || []) {
    if (!toolRegistry) toolRegistry = new ToolRegistry();
    toolRegistry.register(name, resolveAgentForgeTool(name));
    toolsConfig[name] = { tool: name };
  }

  const agent = AgentBuilder.create()
    .setId(agentId)
    .setName(spec.name)
    .setPrompt(spec.prompt)
    .setTools(toolsConfig)
    .build();

  const hooks = compileHooksFromSpecPolicy(spec.policy?.hooks, sandbox, options.hookTimeoutMs);

  return { agent, provider, toolRegistry, hooks, sandbox };
}

/**
 * LOU-T3: reads back the `AgentFlow` a branching (`router`-node) canvas
 * graph's `graphToSpec()` stashed under `spec.policy.flow` (see
 * `apps/agent-forge/src/graph/graphToFlow.ts`/`graphToSpec.ts`) - the
 * signal `runRegistry.ts` uses to run this agent through `FlowExecutor`
 * instead of `AgentExecutor.execute()`. Deliberately best-effort/lenient
 * (mirrors `specToGraph.ts`'s `isSerializedHookArray()` for the same
 * `spec.policy` open-passthrough-record reasoning): a spec whose
 * `policy.flow` isn't shaped like an `AgentFlow` (hand-edited, or from an
 * older spec file that predates this field) is treated as "no flow" rather
 * than thrown on, so it falls back to the flat-spec `AgentExecutor` path
 * exactly like it always has.
 */
export function extractFlowFromSpec(spec: AgentSpec): AgentFlow | undefined {
  const raw = spec.policy?.flow;
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<AgentFlow>;
  if (typeof candidate.code !== 'string' || typeof candidate.name !== 'string' || !candidate.flow) {
    return undefined;
  }
  return candidate as AgentFlow;
}
