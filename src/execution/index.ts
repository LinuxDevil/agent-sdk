/**
 * Execution Module
 * Agent execution engine with streaming support
 */

// A3: the executor API moved to '@lousho/build-ai-agent/executor'. The
// root keeps PropagatingToolError and the result types createAgent() uses.
export { PropagatingToolError } from './propagatingToolError';
export type { ExecutionResult, ExecutionFinishReason } from './AgentExecutor';
export * from './errors';
// A1: StorageServiceApprovalStore moved to '@lousho/build-ai-agent/utils'.
export {
  ASK_QUESTION_TOOL_NAME,
  describeApproval,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalQuestion,
  type ApprovalSignIn,
  type ApprovalStore,
  type ExecutionSnapshot,
  type PausedBackgroundTask,
  type PendingApproval,
  type ResolvedApproval,
  type SubagentSuspension,
  type SuspendedBackgroundTasks,
} from './ApprovalGate';
export { InMemoryApprovalStore } from './InMemoryApprovalStore';
// A3: the resume functions moved to '@lousho/build-ai-agent/executor'.
// A1: LocalStorageCheckpointStore moved to '@lousho/build-ai-agent/utils'.
export {
  appendToRing,
  DEFAULT_CHECKPOINT_HISTORY_LIMIT,
  getCheckpointHistory,
  newestFirst,
  resolveHistoryLimit,
  RUN_CONFIG_KEY,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointStatus,
  type CheckpointStore,
  type ForkOptions,
  type ForkPatch,
  type ForkResult,
} from './checkpoint';
export * from './tracing';
export * from './semconv';
export * from './logger';
export * from './guardrails';
export { GuardrailError, maxLengthGuardrail, regexGuardrail, denyTopicsGuardrail, llmJudgeGuardrail } from './ioGuardrails';
export type {
  AgentGuardrails,
  GuardrailTrip,
  GuardrailTripInfo,
  IoGuardrail,
  IoGuardrailContext,
  IoGuardrailKind,
  IoGuardrailResult,
  ModerationCategory,
  PiiType,
} from './ioGuardrails';
export { piiGuardrail, secretsGuardrail, promptInjectionGuardrail, moderationGuardrail } from './guardrailStarterSet';
export * from './hooks';
export { ToolArgumentsValidationError } from './toolArgsValidation';
export type { ToolArgumentIssue } from './toolArgsValidation';
export { toolErrorResult } from './toolErrors';
export type { ToolErrorKind, ToolErrorResult, ToolErrorInput } from './toolErrors';
export { allow, ask, deny } from './permissions';
export type {
  PermissionAction,
  PermissionAuditContext,
  PermissionContext,
  PermissionDecision,
  PermissionDecisionEntry,
  PermissionMode,
  PermissionModeChange,
  PermissionOptions,
  PermissionRule,
  PermissionToolMatcher,
} from './permissions';
export type { OutputError } from './structuredOutput';
export type { ToolConcurrency } from './toolBatch';
export {
  AGENT_EVENT_SCHEMA_VERSION,
  isAgentEvent,
  isToolEvent,
  isTextEvent,
  isStepEvent,
} from './agentEvents';
export type {
  AgentEvent,
  AgentEventType,
  AgentEventOf,
  AgentEventBase,
  AgentEventUsage,
  AgentEventError,
  RunStartEvent,
  StepStartEvent,
  TextDeltaEvent,
  TextDoneEvent,
  ReasoningStartEvent,
  ReasoningDeltaEvent,
  ReasoningDoneEvent,
  ToolStartEvent,
  ToolPartialEvent,
  ToolDoneEvent,
  TodoUpdatedEvent,
  ToolErrorEvent,
  ApprovalRequestedEvent,
  PermissionDecisionEvent,
  StepDoneEvent,
  AgentErrorEvent,
  ProviderRetryEvent,
  ProviderFallbackEvent,
  BudgetExceededEvent,
  InputQueuedEvent,
  InputSteeredEvent,
  InputAppliedEvent,
  GuardrailTrippedEvent,
  GuardrailRewroteEvent,
  AgentDriftEvent,
  HandoffEvent,
  RunDoneEvent,
} from './agentEvents';
export type { HandoffInputData, HandoffMarker, HandoffTarget, ResolvedHandoff } from './handoffRun';
// Tool search: deferred tools and the tool_search tool (N2)
export type { ToolSearchOptions, ToolSearchResult } from './toolSearch';
// Code mode: the run_code tool (N14)
export type { CodeModeOptions } from './codeMode';
export { rankToolsByKeywords } from '../tools/toolSearchRank';
export { BudgetExceededError } from './budget';
export type { BudgetExceeded, BudgetLimit, BudgetSpent, RunLimits, SessionBudget } from './budget';
export type { AgentRun } from './agentRun';
export type { AgentDrift, AgentDriftMode, AgentFingerprint } from './agentFingerprint';
export { InputQueue } from './inputQueue';
export type { EnqueueResult, SteerResult } from './inputQueue';
export { emptyRunUsage } from './runUsage';
