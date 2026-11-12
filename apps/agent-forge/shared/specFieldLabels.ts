/**
 * Display labels for spec fields, shared by the Versions tab chips
 * (`src/screens/agentDetail/versionLabels.ts`, L01) and the server's
 * version-summary digest (`server/passes/versionSummary.ts`, L04) - one
 * table so a field reads the same in the UI and in the summary prompt.
 * `FIELD_LABELS` covers every top-level `AgentSpecV2` key the version
 * records report in `changedFields`, plus 'labels' (the meta state a
 * snapshot carries); unknown keys fall back to the raw field name.
 */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  labels: 'Labels',
  model: 'Model',
  fallbackModels: 'Fallback models',
  instructions: 'Instructions',
  instructionsByFamily: 'Instructions per model family',
  promptRef: 'Prompt reference',
  modelSettings: 'Model settings',
  reasoning: 'Reasoning',
  tools: 'Tools',
  mcpServers: 'MCP servers',
  skills: 'Skills',
  memory: 'Memory',
  subagents: 'Subagents',
  subagentOptions: 'Subagent options',
  maxSubagentDepth: 'Subagent depth',
  handoffs: 'Handoffs',
  maxHandoffs: 'Handoff limit',
  guardrails: 'Guardrails',
  permissions: 'Permission rules',
  permissionMode: 'Permission mode',
  approvalTtlMs: 'Approval timeout',
  askQuestion: 'Ask questions',
  hooks: 'Hooks',
  output: 'Structured output',
  limits: 'Limits',
  maxSteps: 'Max steps',
  compaction: 'Compaction',
  retry: 'Retries',
  rateLimit: 'Rate limit',
  promptCaching: 'Prompt caching',
  toolSearch: 'Tool search',
  codeMode: 'Code mode',
  triggers: 'Triggers',
  abortListeners: 'Abort listeners',
  flow: 'Flow',
  evals: 'Eval gates',
};

/** The chip text for a changed-field key: its label, or the key itself when unmapped. */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}
