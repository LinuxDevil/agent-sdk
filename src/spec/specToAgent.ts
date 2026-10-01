import { AgentSpec, McpServerSpec } from './schema';
import { createAgent, SimpleAgent, CreateAgentConfig } from '../createAgent';
import { resolveProvider } from '../providers/resolveProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { ConfigurationError } from '../execution/errors';
// Side-effect import: '../providers/mock' self-registers 'mock' into
// LLMProviderRegistry (see the bottom of src/providers/mock.ts for why).
// specToAgent resolves provider types dynamically by string via
// LLMProviderRegistry.create() below, but nothing else in this module's
// dependency graph references a providers module as a VALUE (only as
// types, e.g. LLMProvider), so bundlers (tsup/esbuild) never pull any
// providers module into CLI bundles like dist/cli/dev.js that don't also
// go through src/index.ts. Without this explicit import, `loushy dev` (and
// anything else that loads a spec directly, bypassing the SDK's top-level
// index.ts) never actually registers 'mock' at runtime, even though the
// registration code exists. This imports mock.ts specifically (not the
// whole '../providers' barrel) because mock.ts has no external
// dependencies - importing the full barrel would also eagerly pull in
// OpenAIProvider/OllamaProvider/OpenRouterProvider, whose top-level
// imports of their optional peer-dependency SDKs ('@ai-sdk/openai',
// 'ollama-ai-provider', ...) would then crash `loushy dev` for the exact
// zero-API-key/zero-extra-installs use case this fix exists for.
import '../providers/mock';
import { httpTool } from '../tools/built-in/http';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { ToolDescriptor } from '../types';

const REAL_PROVIDER_TYPES = new Set(['openai', 'anthropic', 'ollama', 'openrouter']);

/**
 * Resolves a spec's provider config to an LLMProvider. Real provider types
 * go through LOU-F8's resolveProvider() (env-var driven credentials, as
 * usual). Any other registered type - notably 'mock', which intentionally
 * has no env var and is never part of resolveProvider()'s whitelist - is
 * created directly via LLMProviderRegistry. This is what lets `loushy dev`
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
};

const CREDENTIALED_TOOLS = new Set(['github', 'jira']);

/**
 * Resolves one AgentSpec `tools` entry to its built-in ToolDescriptor.
 * Exported (LOU-I2) so generated deployment servers (src/deploy) resolve
 * spec tools exactly the way specToAgent()/`loushy dev` do.
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
      'LOUSHY_TOOL_NEEDS_CREDENTIALS'
    );
  }

  throw new ConfigurationError(
    `specToAgent: unknown tool '${name}'. Known built-in tools: ${Object.keys(RESOLVABLE_BUILT_IN_TOOLS).join(', ')}`,
    'tools',
    'LOUSHY_TOOL_NOT_FOUND'
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
 * `spec.mcpServers` go to `createAgent({ mcpServers })` (LOU-Z4): they connect
 * on `agent.ready()` or the first `send()` / `stream()`, and `agent.close()`
 * disconnects them. They stay readable as `agent.mcpServers`.
 */
export function specToAgent(spec: AgentSpec): SpecAgent {
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
  });
  return Object.assign(agent, { mcpServers });
}
