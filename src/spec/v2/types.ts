/**
 * The AgentSpec v2 data shape. Hand-written and kept in lockstep with
 * schema.ts, like v1's `AgentSpec`: the SDK's published types do not depend
 * on the installed zod major.
 */
import type { CodeModeOptions } from '../../execution/codeMode';
import type { RunLimits } from '../../execution/budget';
import type { PermissionMode } from '../../execution/permissions';
import type { ToolSearchOptions } from '../../execution/toolSearch';
import type { ModelSettings } from '../../providers/llm';
import type { PromptCachingOption } from '../../providers/promptCaching';
import type { RateLimitOptions } from '../../providers/rateLimit';
import type { ReasoningOption } from '../../providers/reasoning';
import type { BackoffOptions } from '../../providers/resilience';
import type { SubagentOptions } from '../../subagents/backgroundTasks';
import type { McpServerSpec } from '../schema';
import type { GuardrailSpec } from './guardrails';

/** AgentSpec v2. Hand-written and kept in lockstep with schema.ts, like v1's AgentSpec. */
export interface AgentSpecV2 {
  version: 2;
  name: string;
  description?: string;
  model: string;
  fallbackModels?: string[];
  instructions: string | { file: string };
  instructionsByFamily?: Record<string, string>;
  promptRef?: string;
  modelSettings?: ModelSettings;
  reasoning?: ReasoningOption;
  limits?: RunLimits;
  maxSteps?: number;
  compaction?: boolean | AgentSpecV2Compaction;
  retry?: false | AgentSpecV2Retry;
  rateLimit?: RateLimitOptions;
  promptCaching?: PromptCachingOption;
  toolSearch?: false | Omit<ToolSearchOptions, 'search'>;
  codeMode?: boolean | CodeModeOptions;
  permissionMode?: PermissionMode;
  approvalTtlMs?: number;
  askQuestion?: boolean;
  mcpServers?: Record<string, McpServerSpec>; // S03 widens the value type with secret refs
  subagentOptions?: Omit<SubagentOptions, 'sessions'>;
  maxSubagentDepth?: number;
  maxHandoffs?: number;
  // Sections not landed yet. Each later ticket replaces exactly its own line.
  tools?: never; // S04a
  skills?: never; // S14
  memory?: never; // S13
  subagents?: never; // S08
  handoffs?: never; // S09
  guardrails?: GuardrailSpec[]; // S11
  permissions?: never; // S10
  hooks?: never; // S12
  output?: never; // S15
  triggers?: never; // S22
  abortListeners?: never; // R03
  flow?: never; // S21
  evals?: never; // X01
}

/** `compaction` as data (AgentCompactionOptions minus `strategy` / `onCompaction`; `summarizer` is a 'provider/model' string). */
export interface AgentSpecV2Compaction {
  thresholdPercent?: number;
  contextWindow?: number;
  protectedTokens?: number;
  reserveOutputTokens?: number;
  summarizer?: string;
}

/** `retry` as data (WithRetryOptions minus the function and signal fields). */
export interface AgentSpecV2Retry {
  maxRetries?: number;
  backoff?: BackoffOptions;
  timeoutMs?: number;
  idleTimeoutMs?: number;
}
