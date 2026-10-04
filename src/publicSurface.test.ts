/**
 * A1 (wave 4): pins the public-surface split across the package entries.
 * Every name a breaking-change ticket moves or removes is asserted absent
 * from the root (and, for a move, present on its subpath). Later tickets
 * (A2a, A2b, A2c, A3, A5) append the names they remove or move here and in
 * publicSurface.test-d.ts.
 */
import { describe, it, expect } from 'vitest';
import * as root from './index';
import * as flows from './flows';
import * as integrations from './integrations';
import * as utils from './utils';

type Entry = Record<string, unknown>;

/** [module, specifier, names] - each name must be on the module and OFF the root. */
const MOVED: Array<[mod: Entry, specifier: string, names: string[]]> = [
  [
    flows as Entry,
    '@lousho/build-ai-agent/flows',
    [
      'FlowBuilder',
      'FlowExecutor',
      'FlowChunkType',
      'extractVariableNames',
      'replaceVariablesInString',
      'injectVariables',
      'applyInputTransformation',
      'createDynamicZodSchemaForInputs',
      'validateFlowInput',
      'INPUT_TYPE_LABELS',
      'isCreateAgentResult',
      'validateFlow',
      'validateAgentDefinition',
    ],
  ],
  [
    integrations as Entry,
    '@lousho/build-ai-agent/integrations',
    [
      'createEmailTool',
      'createJiraTools',
      'JiraTools',
      'createGitHubTools',
      'GitHubTools',
      'createSlackTool',
      'slackTool',
      'postSlackAlert',
      'postSlackAlertViaSandbox',
      'buildSlackAlertPayload',
      'SLACK_WEBHOOK_URL_ENV_KEY',
    ],
  ],
  [
    utils as Entry,
    '@lousho/build-ai-agent/utils',
    [
      'EncryptionUtils',
      'DTOEncryptionFilter',
      'DecryptionError',
      'generatePassword',
      'sha256',
      'StorageService',
      'StorageServiceApprovalStore',
      'LocalStorageCheckpointStore',
      'validateWithSchema',
      'safeValidate',
      'isValidEmail',
      'isValidUrl',
      'isValidJson',
      'sanitizeString',
      'hasRequiredKeys',
    ],
  ],
];

describe('public surface (A1): moved values are on their subpath, off the root', () => {
  for (const [mod, specifier, names] of MOVED) {
    for (const name of names) {
      it(`${name}: on ${specifier}, not on the root`, () => {
        expect(mod, `${specifier} should export ${name}`).toHaveProperty(name);
        expect(root, `the root should no longer export ${name}`).not.toHaveProperty(name);
      });
    }
  }
});

/** A2a: runtime values removed from the package. */
const REMOVED_A2A = [
  'AgentType',
  'DataLoadingStatus',
  'agentTypesRegistry',
  'getAgentTypeDescriptor',
  'getAllAgentTypeDescriptors',
  'isValidAgentType',
  'validateAgentConfig',
  'validateAgentTools',
];

describe('public surface (A2a): removed values are off the root', () => {
  for (const name of REMOVED_A2A) {
    it(`${name}: not on the root`, () => {
      expect(root, `the root should no longer export ${name}`).not.toHaveProperty(name);
    });
  }
});
