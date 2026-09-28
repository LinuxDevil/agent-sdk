import { AgentSpec } from './schema';
import { createAgent, SimpleAgent, CreateAgentConfig } from '../createAgent';
import { resolveProvider } from '../providers/resolveProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
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

function resolveTool(name: string): ToolDescriptor {
  const tool = RESOLVABLE_BUILT_IN_TOOLS[name];
  if (tool) return tool;

  if (CREDENTIALED_TOOLS.has(name)) {
    throw new Error(
      `specToAgent: tool '${name}' needs credentials (see src/tools/built-in/${name}.ts's ` +
        `create${name === 'github' ? 'GitHub' : 'Jira'}Tools(config)) that an AgentSpec has no ` +
        `field for. Build this agent with createAgent() directly and pass the configured tool instead.`
    );
  }

  throw new Error(
    `specToAgent: unknown tool '${name}'. Known built-in tools: ${Object.keys(
      RESOLVABLE_BUILT_IN_TOOLS
    ).join(', ')}`
  );
}

/**
 * Maps a validated AgentSpec to a live agent via createAgent() (LOU-H1),
 * resolving each spec tool name against the SDK's real built-in tools.
 */
export function specToAgent(spec: AgentSpec): SimpleAgent {
  const provider = resolveSpecProvider(spec.provider.type, spec.provider.model);

  const tools: CreateAgentConfig['tools'] = {};
  for (const name of spec.tools || []) {
    tools[name] = resolveTool(name);
  }

  return createAgent({
    name: spec.name,
    prompt: spec.prompt,
    provider,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
  });
}
