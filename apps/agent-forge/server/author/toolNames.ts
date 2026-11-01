/**
 * The Author's tool surface (PLAN 8.2), in one alphabetical list. AA06's
 * buildAuthorTools implements them; the prompt test scans the static
 * prompt's prose and requires every camelCase name it mentions to appear
 * here, so the instructions can never name a tool the chat does not have.
 */
export const AUTHOR_TOOL_NAMES = [
  'discardPendingChanges',
  'getCurrentSpec',
  'getTrace',
  'listAgents',
  'listGuardrails',
  'listKits',
  'listMcpServers',
  'listModels',
  'listSkills',
  'listTemplates',
  'listTools',
  'listTriggerTypes',
  'openPage',
  'probeMcpServer',
  'proposeAgent',
  'proposeAgentUpdate',
  'requestSecret',
  'runDraft',
  'saveAgent',
  'saveAgentUpdate',
  'searchDocs',
  'setAgentEnabled',
] as const;
