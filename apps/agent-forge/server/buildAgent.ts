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
  type ToolDescriptor,
} from '@loushy/build-ai-agent';
import { compileHooksFromSpecPolicy } from './compileHooks';

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

export function buildAgentFromSpec(spec: AgentSpec, agentId: string, sandbox: SandboxAdapter = NoopSandbox): BuiltAgent {
  const provider = resolveSpecProvider(spec.provider.type, spec.provider.model);

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

  const hooks = compileHooksFromSpecPolicy(spec.policy?.hooks, sandbox);

  return { agent, provider, toolRegistry, hooks, sandbox };
}
