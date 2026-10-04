# Upgrading to 1.0

## Who needs this page

Anyone with code written against `1.0.0-alpha.8` or an earlier `1.0.0-alpha.*`
release. Between the last alphas and `1.0.0-rc.0` the package's public surface
was reorganized: imports moved to subpaths, dead or superseded APIs were
removed, and the patch guardrails were renamed patch checks. `createAgent()`
and its options did not change - an agent that only does
`createAgent({ model, instructions, tools })` and `agent.send()` upgrades by
changing nothing but the version.

```bash
npm install @lousho/build-ai-agent@^1.0.0-rc.0
```

## Import paths that moved

The package root now holds `createAgent()` and the names its config and
results use. Everything below moved to a dedicated subpath; the declarations
are unchanged apart from where they live.

| Name(s) | Old import | New import |
| ------- | ---------- | ---------- |
| `AgentExecutor`, `AgentBuilder`, `ExecuteOptions`, `ResumeExecuteOptions`, `ResumeRequest`, `resumeAfterApproval()`, `streamResumeAfterApproval()`, `resumeRequest()` | `@lousho/build-ai-agent` or `@lousho/build-ai-agent/core` | `@lousho/build-ai-agent/executor` |
| `ToolRegistry`, `globalToolRegistry` | `@lousho/build-ai-agent` or `@lousho/build-ai-agent/core` | `@lousho/build-ai-agent/executor` (also still in `@lousho/build-ai-agent/tools`) |
| `ExecutionResult`, `ExecutionFinishReason` (the executor's types) | `@lousho/build-ai-agent/core` | `@lousho/build-ai-agent/executor` (`ExecutionResult` is also still in the root, where `createAgent()`'s result type lives) |
| `FlowBuilder`, `FlowExecutor`, `validateFlow` and every flow type (`AgentFlow`, `EditorStep`, `FlowExecutionEvent`, ...) | `@lousho/build-ai-agent` or `@lousho/build-ai-agent/types` | `@lousho/build-ai-agent/flows` |
| `createJiraTools`, `createGitHubTools`, `createSlackTool`, `slackTool`, `postSlackAlert`, `createEmailTool` and their types | `@lousho/build-ai-agent` or `@lousho/build-ai-agent/tools` | `@lousho/build-ai-agent/integrations` |
| `EncryptionUtils`, `DTOEncryptionFilter`, `DecryptionError`, `sha256`, `generatePassword` | `@lousho/build-ai-agent` | `@lousho/build-ai-agent/utils` |
| `StorageService`, `StorageServiceApprovalStore`, `LocalStorageCheckpointStore` | `@lousho/build-ai-agent` | `@lousho/build-ai-agent/utils` (with `createAgent()` stores, prefer `fileStore(dir)` from the root) |
| `validateWithSchema`, `safeValidate`, `isValidEmail` and the other validators | `@lousho/build-ai-agent` | `@lousho/build-ai-agent/utils` |

The `@lousho/build-ai-agent/core` subpath no longer exists; everything it
exported is under `/executor`.

```ts
import { AgentExecutor, AgentBuilder, ToolRegistry } from '@lousho/build-ai-agent/executor';
import { FlowBuilder, validateFlow } from '@lousho/build-ai-agent/flows';
import { createSlackTool } from '@lousho/build-ai-agent/integrations';
import { EncryptionUtils, validateWithSchema } from '@lousho/build-ai-agent/utils';
```

## Removed APIs and their replacements

- **`AgentType`, `AgentTypeDescriptor`, `AgentConfig.agentType`,
  `AgentBuilder.setType()` and the agent-type registry**
  (`agentTypesRegistry`, `getAgentTypeDescriptor`, `getAllAgentTypeDescriptors`,
  `isValidAgentType`, `validateAgentConfig`, `validateAgentTools`). They had no
  runtime effect: delete the `setType(...)` call and the `agentType` field. A
  checkpoint saved with `agentType` still loads; the field is ignored.
- **`ExecuteOptions.onEvent`** and the `ExecutionEvent` / `ExecutionEventType`
  types. Pass `onAgentEvent` to `AgentExecutor.execute()` / `stream()` /
  `resumeAfterApproval()` instead; the events you now receive are `AgentEvent`s.
  The event-name mapping is in
  [Streaming](./streaming.md#migrating-from-onevent--executionevent). With `createAgent()`, `onEvent` already
  receives `AgentEvent`s and is unchanged.
- **`createDelegateTool()`**, `DelegateAgentOptions`, `DelegateAgentResult` and
  `DelegationDepthExceededError`. Use the `subagents` option on `createAgent()`
  or `AgentExecutor.execute()`: the model gets one `task` tool per sub-agent,
  with a depth limit (`maxSubagentDepth`, default `1`) instead of the thrown
  error. See [Sub-agents](./sub-agents.md).
- **Types nothing implemented or used**: the repository interfaces
  (`IRepository`, `IAgentRepository`, `ISessionRepository`, `IResultRepository`,
  `SessionData`, `ResultData`, `SDKRepositories`), `DataLoadingStatus`,
  `PaginationParams`, `PaginatedResponse`, `DeepPartial`, `Timestamped`,
  `IdEntity`, `AgentExecutionOptions`, `AgentExecutionResult`, `AgentDefinition`
  and `ToolSetting`. If your code used one, copy its declaration into your
  project.

```ts no-verify
// Before (alpha):
import { createDelegateTool } from '@lousho/build-ai-agent';
const delegate = createDelegateTool({ agent: billing, name: 'billing' });
```

```ts
// After (1.0): the lead gets a `task` tool per sub-agent.
import { createAgent } from '@lousho/build-ai-agent';

const billing = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You answer billing questions.' });
const lead = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'Route questions to the right specialist.',
  subagents: { billing },
});
```

## Renamed APIs

The patch guardrails are now called patch checks, so "guardrail" only means
the input/output/tool guardrails of `createAgent({ guardrails })`. Arguments,
results and behavior are unchanged; `SECRET_PATTERNS` keeps its name. See
[Guardrails and sandboxing](./guardrails.md).

| Old name | New name |
| -------- | -------- |
| `runGuardrails` | `runPatchChecks` |
| `Guardrail` | `PatchCheck` |
| `GuardrailResult` | `PatchCheckResult` |
| `ProposedAction` | `ProposedPatch` |
| `RunGuardrailsResult` | `RunPatchChecksResult` |
| `runGuardrailSafely` | `runPatchCheckSafely` |
| `secretScanGuardrail` | `secretScanCheck` |
| `createDiffSizeGuardrail` | `createDiffSizeCheck` |
| `createCommandGuardrail` | `createCommandCheck` (options type `CommandCheckOptions`) |
| `createTestRunGuardrail` | `createTestRunCheck` |
| `createLintGuardrail` | `createLintCheck` |

## Deprecated, still working in 1.x

These names still work in 1.x and are removed in 2.0. Move off them when you
touch the code; nothing breaks if you do not.

| Deprecated | Replacement |
| ---------- | ----------- |
| `SlackTriggerAdapter` (`@lousho/build-ai-agent/triggers`) | `slackChannel()`, mounted with `mountChannels()` - sessions per thread, approval buttons. See [Channels](./channels.md) |
| `CronTriggerAdapter` | `defineSchedule()` with `startSchedules()`, `schedules/` in an agent directory, or cron triggers in a spec file. See [Schedules](./schedules.md) |
| `WebhookTriggerAdapter` | `webhookChannel()`, mounted with `mountChannels()`. See [Channels](./channels.md) |
| The adapters' options types (`SlackTriggerAdapterOptions`, `CronTriggerAdapterOptions`, `WebhookTriggerAdapterOptions`) and `WebhookTriggerHandle` | The corresponding channel/schedule option types. `verifySlackSignature()`, the `WebhookAuth` helpers, `parseCronExpression()`, `TriggerAdapter` and `TriggerRegistry` are **not** deprecated |
| `ToolRunContext` | `ToolExecutionContext`, the one public execute-context type |
| `RunUsage.promptTokens` | `RunUsage.inputTokens` |
| `RunUsage.completionTokens` | `RunUsage.outputTokens` |
| `AiSdkProvider.convertMessages()` (a protected `ai` v4-shaped hook) | Do not override it in new code; it stays for the built-in providers until 2.0. See [Providers](./providers.md) |

## Other behavior changes since alpha.8

The full list is in the [CHANGELOG](../CHANGELOG.md). The entries that change
runtime behavior or types your code may rely on, one line each:

- The moves, removals and renames above are the `### Breaking` section; the
  notes below are the `### Changed` entries that alter behavior.
- A tool whose `execute` returns an async generator is now iterated - its last
  yielded value is the result - and `AgentEvent` gains `tool.partial`
  (`ToolPartialEvent`); wrap a generator you mean to return as a value
  (`{ items: generator }`). See [Tools](./tools.md) and
  [Stream events](./stream-events.md).
- `AgentEvent` gains the `handoff` event and `ExecutionResult` the optional
  `agentName`: an exhaustive `switch` over `event.type` needs a `handoff`
  case. See [Handoffs](./handoffs.md).
- `McpServerStatus` gains `'needs-auth'` and `AgentOAuth` gains
  `mcpSignInUrl(server)`: an exhaustive `switch` over `connectMcp().status()`
  needs the new case. See [MCP](./mcp.md) and [OAuth](./oauth.md).
- `ToolExecutionContext` gains `getToken(provider)` and `requireAuth(provider)`,
  and `ApprovalKind` gains `'sign-in'`: a hand-built tool context in a test
  needs the two methods (or a cast). See [OAuth](./oauth.md).
- With a listener (`createAgent({ onEvent })`, `onAgentEvent`), `send()` and
  `execute()` now stream model calls: a step's text arrives as several
  `text.delta` events instead of one. `execute({ streamModelCalls: false })`
  restores the old shape. See [Stream events](./stream-events.md).
- `MockLLMProvider` / `createMockProvider()`: `stream()` now streams the same
  step `generate()` returns - the same tool calls, finish reason and usage -
  so a streamed mock run calls tools as `send()` does. See
  [Testing](./testing.md).
- Agent Forge runs stream their model calls; the chat, logs and trace views
  are unchanged. See [Agent Forge](./agent-forge.md).
- `lousho init --provider ollama` now scaffolds `ai@^7` with
  `ollama-ai-provider-v2@^4` and `zod@^4` (it was `ai@^4` with
  `ollama-ai-provider@^1` and zod 3). Existing projects are untouched. See
  [Installation](./installation.md#provider-packages).
- A run paused inside a sub-agent compares the sub-agent with its current
  definition on resume, under the lead's `onAgentDrift` - with `'error'` a
  changed sub-agent now rejects `agent.approvals.resolve()` too. See
  [Durable execution](./durable-execution.md#resuming-with-a-changed-agent).
- `lousho add` enforces the registry permission manifest at install, and a
  loaded agent directory runs each item's tools inside its accepted manifest
  (approval always on for `exec`/`needsApproval`/unattested items, `fetch`
  and `process.env` scoped to the declaration); mismatched code is refused
  with `LOUSHO_REGISTRY_MANIFEST_MISMATCH`, and `--yes` needs `--allow` for
  elevated permissions. See [Registry](./registry.md#permission-manifest).
- Continuing an unfinished checkpointed run with a `principal` other than the
  one it was saved with now throws `LOUSHO_CONFIG_INVALID`; checkpoints and
  approval snapshots store the run's principal. See
  [Route auth and principals](./auth.md).
- The published package is smaller: test-only files no longer ship, and
  source maps no longer embed `sourcesContent` (their `sources` still resolve
  to the shipped `src/`). No API change.

## What 1.0 promises

Starting at 1.0 the package follows semver on its public surface:

- **Public**: every entry point `exports` declares - the root
  `@lousho/build-ai-agent` and the `/executor`, `/tools`, `/flows`,
  `/integrations`, `/utils`, `/mcp`, `/types`, `/testing`, `/otel`, `/hooks`,
  `/sqlite`, `/auth`, `/kv`, `/worker`, `/traces`, `/triggers`, `/react`,
  `/vue` and `/svelte` subpaths - and every name in the checked-in API
  reports (`api/index.api.md`, `api/executor.api.md`, ... in the repository).
  Removing or renaming one, or changing a signature, needs a major version.
- **Internal**: everything else, including deep imports into `dist/` or
  `src/` (any path `exports` does not list) and names a public signature uses
  but does not export (the `ae-forgotten-export` entries in the reports).
  These can change in any release.
- **Deprecated**: names marked `@deprecated` keep working through 1.x and are
  removed in 2.0.

CI compares the reports on every pull request, so a change to the public
surface is always a deliberate, reviewed diff.
