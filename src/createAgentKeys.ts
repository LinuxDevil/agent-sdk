/**
 * The option keys createAgent() accepts. An unknown key (`maxOutputTokens`,
 * `system`, a typo) is rejected with a "did you mean" instead of being
 * silently ignored, which TypeScript only catches for object literals.
 */
import type { ClaudeProject } from './claude/claudeProject';
import type { CreateAgentConfig } from './createAgent';
import { ConfigurationError } from './execution/errors';
import { MODEL_SETTING_KEYS, SETTING_SYNONYMS } from './execution/modelSettings';
import { unknownOptionKey } from './utils/knownOptionKeys';

/** Every {@link CreateAgentConfig} key; `satisfies` keeps it in step with the type. */
const CREATE_AGENT_KEYS = {
  tools: true,
  mcpServers: true,
  skills: true,
  name: true,
  description: true,
  subagents: true,
  subagentOptions: true,
  handoffs: true,
  maxHandoffs: true,
  toolSearch: true,
  codeMode: true,
  maxSubagentDepth: true,
  maxSteps: true,
  limits: true,
  guardrails: true,
  toolConcurrency: true,
  maxToolResultChars: true,
  toolErrorMessage: true,
  onAgentDrift: true,
  reasoning: true,
  modelSettings: true,
  promptCaching: true,
  onEvent: true,
  exporter: true,
  captureContent: true,
  redactContent: true,
  projectInstructions: true,
  store: true,
  approvalStore: true,
  approve: true,
  approvalTtlMs: true,
  askQuestion: true,
  retry: true,
  rateLimit: true,
  fallbackModels: true,
  output: true,
  hooks: true,
  compaction: true,
  memory: true,
  permissions: true,
  onPermissionDecision: true,
  permissionMode: true,
  onPermissionModeChange: true,
  instructions: true,
  prompt: true,
  model: true,
  provider: true,
} as const satisfies Record<keyof CreateAgentConfig, true>;

/** Keys SDK helpers return beside their createAgent() options, so their result spreads in: `createAgent({ provider, ...project })`. */
const SPREAD_HELPER_KEYS = {
  manifest: true,
} as const satisfies Record<Exclude<keyof ClaudeProject, keyof CreateAgentConfig>, true>;

/** Names other agent SDKs use at the top level, mapped to ours (sampling settings live in `modelSettings`). */
const CREATE_AGENT_ALIASES: Readonly<Record<string, string>> = {
  system: 'instructions',
  systemPrompt: 'instructions',
  system_prompt: 'instructions',
  stopWhen: 'maxSteps',
  maxIterations: 'maxSteps',
  maxTurns: 'maxSteps',
  ...Object.fromEntries(MODEL_SETTING_KEYS.map((key) => [key, `modelSettings.${key}`])),
  ...Object.fromEntries(Object.entries(SETTING_SYNONYMS).map(([alias, key]) => [alias, `modelSettings.${key}`])),
};

/** Throws `LOUSHO_CONFIG_INVALID` for a createAgent() option key it does not know, naming the key and a likely fix. */
export function assertKnownCreateAgentKeys(config: CreateAgentConfig): void {
  const unknown = unknownOptionKey(config, { ...CREATE_AGENT_KEYS, ...SPREAD_HELPER_KEYS }, CREATE_AGENT_ALIASES);
  if (!unknown) return;
  throw new ConfigurationError(`createAgent: ${unknown.problem}. Allowed options: ${Object.keys(CREATE_AGENT_KEYS).join(', ')}.`, unknown.key);
}
