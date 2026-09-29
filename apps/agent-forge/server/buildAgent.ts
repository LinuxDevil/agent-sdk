/**
 * Compiles an `AgentSpec` (the app's `graphToSpec()` output, or whatever a
 * saved agent's spec file holds) into the `{agent, provider, toolRegistry}`
 * triple `AgentExecutor.execute()` needs directly.
 *
 * `src/spec/specToAgent.ts`'s own `specToAgent()` does something similar,
 * but it returns a `SimpleAgent` (`{send(message)}`) that hides the
 * AgentConfig/provider/toolRegistry inside a closure and calls
 * `AgentExecutor.execute()` with no `sessionId`/`checkpointStore`/
 * `approvalStore`/`onEvent`/abortable-provider hooks - exactly the things
 * this server needs to wire up N2/N3. So this file composes the same
 * public building blocks `specToAgent()` uses
 * (`resolveSpecProvider`/`resolveSpecTool`/`AgentBuilder`/`ToolRegistry`,
 * all public SDK exports) itself, rather than reaching past `specToAgent()`
 * into SDK internals.
 */
import {
  AgentBuilder,
  AgentType,
  ToolRegistry,
  NoopSandbox,
  LLMProviderRegistry,
  resolveSpecProvider,
  resolveSpecTool,
  type AgentConfig,
  type AgentSpec,
  type HookRegistry,
  type LLMProvider,
  type SandboxAdapter,
  type ToolDescriptor,
} from '@loushy/build-ai-agent';
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
  /**
   * LOU-R1: true when `spec.provider.type` named a real provider
   * (openai/anthropic/ollama/openrouter) but no usable credential was found
   * (no stored key via `secretsStore`, no fallback env var either), so a
   * `mock` provider was substituted to keep the run usable - mirroring the
   * zero-config dev experience `src/spec/specToAgent.ts` already gives
   * `loushy dev`. Callers (runRegistry.ts) surface this as a log line so
   * it's visible rather than a silent swap.
   */
  usedMockProviderFallback: boolean;
}

const REAL_KEYED_PROVIDER_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Real provider types this app doesn't manage a stored key for (no plain-API-key concept, or not yet wired into secretsStore) - env-var-only, with a mock fallback on failure. */
const REAL_ENV_ONLY_PROVIDERS = new Set(['ollama', 'openrouter']);

/**
 * Resolves `spec.provider` to a real `LLMProvider`, preferring a stored key
 * from `secretsStore` (LOU-R1) over the env-var-only path
 * `resolveSpecProvider()` (the core SDK's `src/spec/specToAgent.ts`) uses,
 * and falling back to `mock` whenever a real provider type has no usable
 * credential at all - so this server never becomes unusable for a user who
 * hasn't configured any API keys yet (the same "mock by default" dev
 * experience LOU-H/LOU-N already establish elsewhere).
 */
function resolveProviderForSpec(
  type: string,
  model: string,
  secretsStore?: SecretsStore
): { provider: LLMProvider; usedMockProviderFallback: boolean } {
  const lower = type.toLowerCase();
  const mockProvider = () => LLMProviderRegistry.create('mock', { defaultModel: model || 'mock-1' });

  if (isSecretProvider(lower)) {
    const storedKey = secretsStore?.getKey(lower);
    const key = storedKey || process.env[REAL_KEYED_PROVIDER_ENV[lower]];
    if (key) {
      return {
        provider: LLMProviderRegistry.create(lower, { defaultModel: model, apiKey: key }),
        usedMockProviderFallback: false,
      };
    }
    return { provider: mockProvider(), usedMockProviderFallback: true };
  }

  // Other real provider types this app doesn't manage a stored key for yet
  // (ollama/openrouter) - still try the existing env-var-driven path, but
  // fall back to mock rather than letting a missing/misconfigured env var
  // (e.g. OllamaProvider with no reachable base URL) take the whole run
  // down before it even starts.
  if (REAL_ENV_ONLY_PROVIDERS.has(lower)) {
    try {
      return { provider: resolveSpecProvider(type, model), usedMockProviderFallback: false };
    } catch {
      return { provider: mockProvider(), usedMockProviderFallback: true };
    }
  }

  // 'mock', or any type this app doesn't recognize as a real provider at
  // all (a genuine config error, e.g. a typo'd provider name) - let this
  // throw exactly like it always has, rather than silently masking a bad
  // spec as a working mock run.
  return { provider: resolveSpecProvider(type, model), usedMockProviderFallback: false };
}

export interface BuildAgentFromSpecOptions {
  /** LOU-R1: stored provider keys, checked before falling back to env vars / mock. */
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
  const { provider, usedMockProviderFallback } = resolveProviderForSpec(
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
    .setType(AgentType.SmartAssistant)
    .setName(spec.name)
    .setPrompt(spec.prompt)
    .setTools(toolsConfig)
    .build();

  const hooks = compileHooksFromSpecPolicy(spec.policy?.hooks, sandbox, options.hookTimeoutMs);

  return { agent, provider, toolRegistry, hooks, sandbox, usedMockProviderFallback };
}
