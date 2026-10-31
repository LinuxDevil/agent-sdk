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
import type { GuardrailSpec } from './guardrails';
import type { HookSpec } from './hooks';
import type { McpServerSpecV2 } from './mcpServers';
import type { OutputSpecV2 } from './output';
import type { PermissionRuleSpec } from './permissions';
import type { SecretRef } from './secrets';
import type { ToolRef } from './tools';

/** AgentSpec v2. Hand-written and kept in lockstep with schema.ts, like v1's AgentSpec. */
export interface AgentSpecV2 {
  /** Spec format version; always `2` (v1 specs convert with `upgradeSpec()`). */
  version: 2;
  /** Agent name: 1-64 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit. */
  name: string;
  /** What this agent does, in a sentence; required when used as a subagent or handoff target. */
  description?: string;
  /** The model as 'provider/model', e.g. 'anthropic/claude-sonnet-5-5'. */
  model: string;
  /** 'provider/model' strings tried in order when the primary model's call still fails after its retries. */
  fallbackModels?: string[];
  /** The system prompt: a string, or `{ file }` read under the spec's directory. */
  instructions: string | {
    /** Path to a prompt file relative to the spec's directory (forward slashes, stays inside it). */
    file: string;
  };
  /** Per-family prompt tails: the first key the model id contains is appended to `instructions`. */
  instructionsByFamily?: Record<string, string>;
  /** Prompt-registry ref 'name@label'; `instructions` is the embedded fallback. */
  promptRef?: string;
  /** Sampling settings sent on every model call (createAgent's `modelSettings`). */
  modelSettings?: ModelSettings;
  /** How much the model reasons before it answers (createAgent's `reasoning`). */
  reasoning?: ReasoningOption;
  /** Budgets of each run (createAgent's `limits`). */
  limits?: RunLimits;
  /** Max model steps of a run (createAgent's `maxSteps`). */
  maxSteps?: number;
  /** Context-window compaction (createAgent's `compaction`; `summarizer` is a 'provider/model' string). */
  compaction?: boolean | AgentSpecV2Compaction;
  /** Retries of a failed model call (createAgent's `retry`). */
  retry?: false | AgentSpecV2Retry;
  /** Client-side rate limits on the agent's model calls (createAgent's `rateLimit`). */
  rateLimit?: RateLimitOptions;
  /** Anthropic prompt caching (createAgent's `promptCaching`). */
  promptCaching?: PromptCachingOption;
  /** Tool search tuning (createAgent's `toolSearch`). */
  toolSearch?: false | Omit<ToolSearchOptions, 'search'>;
  /** Code mode (createAgent's `codeMode`). */
  codeMode?: boolean | CodeModeOptions;
  /** Permission mode of the agent's runs (createAgent's `permissionMode`). */
  permissionMode?: PermissionMode;
  /** How long a pause for approval stays decidable, in milliseconds (createAgent's `approvalTtlMs`). */
  approvalTtlMs?: number;
  /** Adds the built-in `ask_question` tool (createAgent's `askQuestion`). */
  askQuestion?: boolean;
  /** MCP servers to connect, keyed by name; SecretRefs allowed in `env`, `headers` and `oauth.clientSecret`. */
  mcpServers?: Record<string, McpServerSpecV2>;
  /** Background sub-agent options (createAgent's `subagentOptions` minus `sessions`). */
  subagentOptions?: Omit<SubagentOptions, 'sessions'>;
  /** How deep sub-agents may nest (createAgent's `maxSubagentDepth`). */
  maxSubagentDepth?: number;
  /** How many handoffs one run may make (createAgent's `maxHandoffs`). */
  maxHandoffs?: number;
  // Sections not landed yet. Each later ticket replaces exactly its own line.
  /** Tool references (S04a): builtin, registry, file, integration, openapi, hosted or hub. */
  tools?: ToolRef[]; // S04a
  /** Skills (S14); not supported yet. */
  skills?: never; // S14
  /** Long-term memory slots (S13); not supported yet. */
  memory?: never; // S13
  /** Sub-agents this agent can delegate to with the `task` tool (S08), keyed by their `sub:<name>` names. */
  subagents?: Record<string, SubagentSpec>; // S08
  /** Agents this agent can hand the conversation to (S09); not supported yet. */
  handoffs?: never; // S09
  /** Input, output and tool guardrails of each run (S11). */
  guardrails?: GuardrailSpec[]; // S11
  /** Permission rules over tool calls (S10). */
  permissions?: PermissionRuleSpec[]; // S10
  /** Hooks run around model and tool calls (S12): files under the base folder or host-sandboxed inline code. */
  hooks?: HookSpec[]; // S12
  /** Structured output: a JSON Schema the final reply is validated into `result.object` with (S15). */
  output?: OutputSpecV2; // S15
  /** Triggers that start runs (S22); not supported yet. */
  triggers?: never; // S22
  /** Listeners that abort queued or running runs (R03); not supported yet. */
  abortListeners?: never; // R03
  /** A flow the run follows instead of a plain agent loop (S21); not supported yet. */
  flow?: never; // S21
  /** Eval gates the publish gate runs (X01); not supported yet. */
  evals?: never; // X01
}

/** A sub-agent written inline: an AgentSpecV2 without the keys only a top-level agent has. `description` is required. */
export type InlineAgentSpec = Omit<AgentSpecV2, 'version' | 'triggers' | 'abortListeners' | 'flow' | 'evals' | 'description'> & {
  /** What this sub-agent does; the lead model reads it to decide which sub-agent to delegate to. */
  description: string;
};

/** One entry of `spec.subagents`: an embedded spec, a spec file or agent folder under the base directory, or a deployed agent. */
export type SubagentSpec =
  | {
      /** Agent spec file (.yaml/.yml/.json) or agent folder, relative to baseDir. */
      ref: string;
    }
  | {
      /** An agent spec embedded in this one. */
      inline: InlineAgentSpec;
    }
  | {
      remote: {
        /** Base URL of the deployed agent; the task goes to `<url>/chat`. */
        url: string;
        /** Bearer token of the deployment, as a SecretRef (never a literal: a spec is a file in git). */
        auth?: SecretRef;
        /** What the remote agent is for, shown to the lead model. */
        description: string;
      };
    };

/** `compaction` as data (AgentCompactionOptions minus `strategy` / `onCompaction`; `summarizer` is a 'provider/model' string). */
export interface AgentSpecV2Compaction {
  /** Compact once the context use passes this fraction of the window. */
  thresholdPercent?: number;
  /** The context window size to compact against (tokens). */
  contextWindow?: number;
  /** Tokens at the tail that are never pruned. */
  protectedTokens?: number;
  /** Tokens reserved for the model's reply when checking the window. */
  reserveOutputTokens?: number;
  /** The summarizer model as 'provider/model'. */
  summarizer?: string;
}

/** `retry` as data (WithRetryOptions minus the function and signal fields). */
export interface AgentSpecV2Retry {
  /** Retries after the first failed call. */
  maxRetries?: number;
  /** Backoff between retries. */
  backoff?: BackoffOptions;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** How long a stalled attempt may go quiet before it counts as failed, in milliseconds. */
  idleTimeoutMs?: number;
}
