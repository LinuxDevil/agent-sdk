import { AgentSpec, McpServerSpec } from './schema';
import { createAgent, SimpleAgent, CreateAgentConfig } from '../createAgent';
import { resolveProvider } from '../providers/resolveProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { ConfigurationError } from '../execution/errors';
// No provider-registration side-effect import is needed here:
// LLMProviderRegistry.create() - reached below directly, and via
// resolveProvider() for the real provider types - registers the built-in
// providers lazily on a miss (LOU-R1), so 'mock', 'openai', 'anthropic',
// 'openrouter' and 'ollama' all resolve in CLI bundles like dist/cli/dev.js
// that never load src/index.ts.
import { httpTool } from '../tools/built-in/http';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { webFetchTool } from '../tools/built-in/webFetch';
import { ToolDescriptor } from '../types';
import { compilePolicy } from './policy';

const REAL_PROVIDER_TYPES = new Set(['openai', 'anthropic', 'ollama', 'openrouter']);

/**
 * Resolves a spec's provider config to an LLMProvider. Real provider types
 * go through LOU-F8's resolveProvider() (env-var driven credentials, as
 * usual). Any other registered type - notably 'mock', which intentionally
 * has no env var and is never part of resolveProvider()'s whitelist - is
 * created directly via LLMProviderRegistry. This is what lets `lousho dev`
 * (LOU-H6/H8) run end-to-end against a MockLLMProvider in tests without
 * real API credentials, while still reusing resolveProvider() verbatim for
 * every real provider type.
 */
export function resolveSpecProvider(type: string, model: string): LLMProvider {
  if (REAL_PROVIDER_TYPES.has(type.toLowerCase())) {
    return resolveProvider(`${type}/${model}`);
  }
  return LLMProviderRegistry.create(type, { defaultModel: model });
}

/**
 * Built-in tool names an AgentSpec's `tools` list can reference without
 * any extra config. 'github' and 'jira' are deliberately NOT in this map:
 * both src/tools/built-in/github.ts and jira.ts export a *factory*
 * (createGitHubTools(config)/createJiraTools(config)) that needs real
 * credentials (token/owner/repo, or baseUrl/email/apiToken) which a
 * spec file has no field for - referencing 'github' or 'jira' in `tools`
 * throws a clear, actionable error instead of silently registering a
 * tool that would fail at call time.
 */
const RESOLVABLE_BUILT_IN_TOOLS: Record<string, ToolDescriptor> = {
  http: httpTool,
  'current-date': currentDateTool,
  'day-name': dayNameTool,
  'web-fetch': webFetchTool,
};

const CREDENTIALED_TOOLS = new Set(['github', 'jira']);

/**
 * Resolves one AgentSpec `tools` entry to its built-in ToolDescriptor.
 * Exported (LOU-I2) so generated deployment servers (src/deploy) resolve
 * spec tools exactly the way specToAgent()/`lousho dev` do.
 */
export function resolveSpecTool(name: string): ToolDescriptor {
  const tool = RESOLVABLE_BUILT_IN_TOOLS[name];
  if (tool) return tool;

  if (CREDENTIALED_TOOLS.has(name)) {
    throw new ConfigurationError(
      `specToAgent: tool '${name}' needs credentials (see src/tools/built-in/${name}.ts's ` +
        `create${name === 'github' ? 'GitHub' : 'Jira'}Tools(config)) that an AgentSpec has no ` +
        `field for. Build this agent with createAgent() directly and pass the configured tool instead.`,
      'tools',
      'LOUSHO_TOOL_NEEDS_CREDENTIALS'
    );
  }

  throw new ConfigurationError(
    `specToAgent: unknown tool '${name}'. Known built-in tools: ${Object.keys(RESOLVABLE_BUILT_IN_TOOLS).join(', ')}`,
    'tools',
    'LOUSHO_TOOL_NOT_FOUND'
  );
}

/** The agent specToAgent() builds, plus the spec's validated MCP servers. */
export type SpecAgent = SimpleAgent & {
  readonly mcpServers: Readonly<Record<string, McpServerSpec>>;
};

/**
 * Maps a validated AgentSpec to a live agent via createAgent() (LOU-H1),
 * resolving each spec tool name against the SDK's real built-in tools.
 *
 * `spec.policy` is compiled by `compilePolicy()` into `createAgent`'s `permissions`,
 * `guardrails`, `limits`, `askQuestion` and `compaction` (LOU-X5); an invalid
 * policy throws a `ValidationError`.
 *
 * `spec.mcpServers` go to `createAgent({ mcpServers })` (LOU-Z4): they connect
 * on `agent.ready()` or the first `send()` / `stream()`, and `agent.close()`
 * disconnects them. They stay readable as `agent.mcpServers`. `options.store`
 * is `createAgent({ store })` (sessions, checkpoints and approvals; LOU-D14).
 */
export function specToAgent(spec: AgentSpec, options: Pick<CreateAgentConfig, 'store' | 'exporter'> = {}): SpecAgent {
  const provider = resolveSpecProvider(spec.provider.type, spec.provider.model);

  const tools: CreateAgentConfig['tools'] = {};
  for (const name of spec.tools || []) {
    tools[name] = resolveSpecTool(name);
  }

  const mcpServers = spec.mcpServers ?? {};
  const agent = createAgent({
    name: spec.name,
    prompt: spec.prompt,
    provider,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    mcpServers,
    store: options.store,
    ...(options.exporter && { exporter: options.exporter }),
    ...compilePolicy(spec.policy),
  });
  return Object.assign(agent, { mcpServers });
}
