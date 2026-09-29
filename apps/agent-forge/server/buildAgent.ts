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
  resolveSpecProvider,
  resolveSpecTool,
  type AgentConfig,
  type AgentSpec,
  type HookRegistry,
  type LLMProvider,
  type SandboxAdapter,
} from '@loushy/build-ai-agent';
import { compileHooksFromSpecPolicy } from './compileHooks';

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

export function buildAgentFromSpec(spec: AgentSpec, agentId: string, sandbox: SandboxAdapter = NoopSandbox): BuiltAgent {
  const provider = resolveSpecProvider(spec.provider.type, spec.provider.model);

  let toolRegistry: ToolRegistry | undefined;
  const toolsConfig: Record<string, { tool: string }> = {};
  for (const name of spec.tools || []) {
    if (!toolRegistry) toolRegistry = new ToolRegistry();
    toolRegistry.register(name, resolveSpecTool(name));
    toolsConfig[name] = { tool: name };
  }

  const agent = AgentBuilder.create()
    .setId(agentId)
    .setType(AgentType.SmartAssistant)
    .setName(spec.name)
    .setPrompt(spec.prompt)
    .setTools(toolsConfig)
    .build();

  const hooks = compileHooksFromSpecPolicy(spec.policy?.hooks, sandbox);

  return { agent, provider, toolRegistry, hooks, sandbox };
}
