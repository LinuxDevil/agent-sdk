import { AgentSpec, McpServerSpec } from './schema';
import { createAgent, SimpleAgent, CreateAgentConfig } from '../createAgent';
import { ConfigurationError } from '../execution/errors';
import { httpTool } from '../tools/built-in/http';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { webFetchTool } from '../tools/built-in/webFetch';
import { ToolDescriptor } from '../types';
import { compilePolicy } from './policy';

// resolveSpecProvider lives in ./provider.ts, shared with the v2 compiler
// (src/spec/v2/specToAgent.ts); re-exported so this module's public surface
// is unchanged.
import { resolveSpecProvider } from './provider';
export { resolveSpecProvider };

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
 * Exported so generated deployment servers (src/deploy) resolve
 * spec tools exactly the way specToAgent()/`lousho dev` do.
 */
export function resolveSpecTool(name: string): ToolDescriptor {
  const tool = RESOLVABLE_BUILT_IN_TOOLS[name];
  if (tool) return tool;

  if (CREDENTIALED_TOOLS.has(name)) {
    throw new ConfigurationError(
      `specToAgent: tool '${name}' needs credentials: build it with ` +
        `create${name === 'github' ? 'GitHub' : 'Jira'}Tools(config) from ` +
        `'lousho/integrations' and pass it to createAgent(); an AgentSpec has no ` +
        `field for credentials.`,
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
 * Maps a validated AgentSpec to a live agent via createAgent(),
 * resolving each spec tool name against the SDK's real built-in tools.
 *
 * `spec.policy` is compiled by `compilePolicy()` into `createAgent`'s `permissions`,
 * `guardrails`, `limits`, `askQuestion` and `compaction`; an invalid
 * policy throws a `ValidationError`.
 *
 * `spec.mcpServers` go to `createAgent({ mcpServers })`: they connect
 * on `agent.ready()` or the first `send()` / `stream()`, and `agent.close()`
 * disconnects them. They stay readable as `agent.mcpServers`. `options.store`
 * is `createAgent({ store })` (sessions, checkpoints and approvals).
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
