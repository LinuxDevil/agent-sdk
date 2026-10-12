# Upgrading to 1.0

## Who needs this page

Anyone with code written against `1.0.0-alpha.8` or an earlier `1.0.0-alpha.*`
release. Between those alphas and the 1.0 line (the changes listed under
`1.0.0-rc.0` in the changelog, published in the later `1.0.0-alpha.*` releases) the package's public surface
was reorganized: imports moved to subpaths, dead or superseded APIs were
removed, and the patch guardrails were renamed patch checks. `createAgent()`
and its options did not change - an agent that only does
`createAgent({ model, instructions, tools })` and `agent.send()` upgrades by
changing nothing but the version.

Already on `1.0.0-alpha.19`? Skip to
[Upgrading from alpha.19](#upgrading-from-alpha19) for what changed on `main`
since.

```bash
npm install @lousho/build-ai-agent@^1.0.0-alpha.19
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
- Memory slots store their items under `<slot name>#<scope key>`
  (`notes#global`) instead of the bare scope key (`global`), so two slots with
  the same scope no longer share items. Items written by `1.0.0-alpha.19` or
  earlier are not read any more; run `migrateMemoryKeys(slot)` once per slot
  to copy them. See
  [Memory](./memory.md#items-from-before-slot-name-keys).
- The published package is smaller: test-only files no longer ship, and
  source maps no longer embed `sourcesContent` (their `sources` still resolve
  to the shipped `src/`). No API change.

## Upgrading from alpha.19

`1.0.0-alpha.19` is the latest release on npm. The changes on `main` since
then (the `[Unreleased]` section of the [CHANGELOG](../CHANGELOG.md)) are
mostly fixes and additions, but some change a default or a behavior your code
may rely on. Each is listed below with the way back to the old behavior, where
there is one. A change marked "no opt-out" closed a security or data-loss bug.

### HTTP routes, servers and channels

| Change | Opt-out |
| ------ | ------- |
| With route auth and no `authorizeSession`, a session belongs to the first principal that sends it a turn (a read claims nothing); another principal gets `403 LOUSHO_SESSION_FORBIDDEN`. The owner is kept in memory per agent (the 100,000 most recently used sessions); a stored session whose owner is not on record (after a restart, past that cap) is refused to everyone, so pass `authorizeSession` on more than one instance or with a store that outlives the process. One bearer token is one caller and checks no owner. See [Who may use a session](./auth.md#who-may-use-a-session). | `authorizeSession: () => true` |
| The session routes (`createRouteHandler()`, `createDeployedServer()`, the Worker, `lousho dev`) refuse a cross-site POST (`403 LOUSHO_REQUEST_FORBIDDEN`) and a POST body that is not `Content-Type: application/json` (`415 LOUSHO_UNSUPPORTED_MEDIA_TYPE`). The new `allowedHosts` (off by default) refuses unlisted `Host` headers. See [Cross-site requests](./auth.md#cross-site-requests). | `allowedOrigins: ['*']`, `requireJsonBody: false` (or list the front end's origin in `allowedOrigins`) |
| `POST /chat/:sessionId/approvals/:id` answers `404` unless the approval belongs to that session, and only the caller the paused run acts for may decide it. | `authorizeApproval` to let others (a supervisor) decide |
| The routes send an error's `name` and `code` with a generic message instead of its raw text (in `error` events, `500` bodies and `provider.retry` / `provider.fallback` events); the full error goes to `console.error`. | `exposeErrors: true` (`lousho dev` sets it) |
| A client that disconnects mid-turn no longer aborts the turn: it runs to its end and is saved. See [Next.js routes](./nextjs.md#routes). | `onDisconnect: 'abort'` |
| `lousho dev` answers `403` to a request whose `Host` is not a loopback name (or, off loopback, an IP address or the `--host` name), against DNS rebinding; this covers `/channels/<name>` for a channel without `verify`. | `--allowed-hosts a,b` (adds to the defaults) |
| A channel without `verify` refuses a browser request from another site (`403 LOUSHO_REQUEST_FORBIDDEN`), and `httpChannel()` without `verify` refuses a body that is not `Content-Type: application/json` (`415 LOUSHO_UNSUPPORTED_MEDIA_TYPE`). See [Channels](./channels.md). | give the channel a `verify` (send the JSON content type from scripts: `curl -H 'Content-Type: application/json'`) |
| `WebhookTriggerAdapter` binds `127.0.0.1` (was `0.0.0.0`), throws `LOUSHO_TRIGGER_INVALID` for a non-loopback `host` without `auth`, and without `auth` refuses a foreign `Host` or a request with an `Origin`. See [Webhook authentication](./triggers.md#webhook-authentication). | `host: '0.0.0.0'` with `auth`, or `allowUnauthenticated: true` |
| The Cloudflare Worker refuses every `/chat` route (a turn, a transcript, an approval decision; `403`) when no `LOUSHO_API_TOKEN` secret is set. `/health`, the OAuth callback and channels stay open. See [Cloudflare Workers](./cloudflare-workers.md). | the `LOUSHO_ALLOW_OPEN_SESSIONS` var (or the earlier `LOUSHO_ALLOW_OPEN_TRANSCRIPTS`) set to `"true"` |
| `serveMcp()` over HTTP checks `Host` and `Origin` against DNS rebinding; loopback is exactly `localhost`, a `127.x.x.x` address or `::1` (also for `WebhookTriggerAdapter`). | `allowedHosts` / `allowedOrigins` on `serveMcp()`'s HTTP transport (`['*']` turns a check off) |
| Agent Forge (`lousho studio`) sends no CORS headers, refuses a foreign `Origin` or non-loopback `Host`, and needs the per-launch token it prints. See [Access token](./agent-forge.md#access-token). | no opt-out |
| `fromUIMessages()` (and so `POST <base>/ui`) drops client-sent `system` messages and any role other than `user` / `assistant`. | no opt-out |
| Slack and Discord signature checks accept a timestamp at most a minute ahead (was five minutes either way), read in seconds. | no opt-out |
| `telegramChannel` and `teamsChannel` no longer post an OAuth sign-in link in a group chat. | no opt-out |
| Channels without a `store` keep their transcripts in the agent's `createAgent({ store })` when it has `sessions`. | pass the channel its own `store` |

### Sessions, approvals and durability

| Change | Opt-out |
| ------ | ------- |
| A checkpointed run holds a run lease while it executes: a second process, replica or store object that sends to the same session, resumes it or resolves one of its approvals fails with `LOUSHO_SESSION_BUSY` instead of running its tool calls a second time. See [Run leases](./durable-execution.md#run-leases). | no opt-out (a custom `CheckpointStore` without `acquireLease()` gets no lease) |
| Approvals run at most once: deciding one re-saves the turn as `'in-progress'` with the call in `Checkpoint.startedToolCallIds`; after a crash mid-call, resuming gives that call a `kind: 'interrupted'` tool error instead of running it again. See [Guarantees](./durable-execution.md#guarantees). | no opt-out |
| Resolving an approval whose run was deleted or replaced fails with `LOUSHO_APPROVAL_ORPHANED` and withdraws it (it used to overwrite the newer conversation). | no opt-out |
| A session turn paused for approval locks the session id: a new turn on it throws `SessionAwaitingApprovalError` (`LOUSHO_SESSION_AWAITING_APPROVAL`). | decide the approval, or `session.discardPending()` |
| Session turns keep the checkpoint history of the latest 10 committed turns. See [Durable sessions](./sessions.md#durable-sessions). | `createAgent({ turnHistoryLimit })` (every session of the agent, including the session routes, `lousho dev`, the deployed server and channels) or `agent.session({ id, turnHistoryLimit })`, with a larger whole number |
| `sessionId` must be 1-200 characters of `A-Za-z0-9_.-` on every store, and may not end in `.turn-<n>`, `.paused` or `.fire` (a schedule's fire claim); `''` is refused. | no opt-out |
| A lease left by a process that died on another machine (or in another container with the same hostname) is taken over 30 to 60 seconds after its last heartbeat (a grace for clock skew), not at 30 seconds. See [Run leases](./durable-execution.md#run-leases). | no opt-out |
| During a rolling upgrade, replicas still on an earlier release neither take nor respect run leases, so a turn can run twice until every replica is upgraded. A SQLite database opened by this release is migrated and then refused by older releases. | upgrade all replicas together; keep a copy of the database to roll back |
| `approvalTtlMs` (and an `ask` rule's `ttlMs`) above 100 years throws `LOUSHO_CONFIG_INVALID` instead of meaning "never expires". | leave it out for pauses that never expire |
| A deterministic provider error records `lastError` on the turn's checkpoint, and later calls on that session fail fast with `LOUSHO_SESSION_TURN_FAILED`. | `session.discardPending()`, or fix the cause and `session.resume()` |
| With a store, tools, `needsApproval`, permission rules and hooks get the session id as `ctx.sessionId`, not the turn checkpoint key `<id>.turn-<n>`. | no opt-out |
| Several calls of one step that need approval pause once, on all of them (`result.approvalIds`); calls that need no approval run before the pause. See [Several calls in one step](./approvals.md#several-calls-in-one-step). | no opt-out |
| `once()` no longer remembers a yes from a `createAgent({ approve })` callback, and an approval note that is exactly `'defer'` defers. | no opt-out |
| A corrupt checkpoint fails with `LOUSHO_CHECKPOINT_CORRUPT` (it threw a raw `SyntaxError`). | no opt-out |
| Memory slots store items under `<slot name>#<scope key>`; items written by alpha.19 are not read. | run `migrateMemoryKeys(slot)` once per slot ([Memory](./memory.md#items-from-before-slot-name-keys)) |
| Keyword recall (`inMemoryMemory`, `fileMemory`, `sqliteMemory`, worker memory) matches whole words instead of substrings. | no opt-out |
| A prompt schedule runs every fire in its own session, `schedule-<name>-<fire time>`. See [Prompt schedules and sessions](./schedules.md#prompt-schedules-and-sessions). | `defineSchedule({ sharedSession: true })` |
| `FlowExecutor.resume()` refuses a flow whose steps changed since the run was saved (`LOUSHO_FLOW_CHANGED`). | no opt-out |

### Providers and model calls

| Change | Opt-out |
| ------ | ------- |
| `createAgent({ provider })` with a built-in provider instance or a `fromAiSdk()` provider and no `retry` wraps it in `withRetry()` with the provider's `maxRetries` (default 2): retries emit `provider.retry`, and `fromAiSdk()` retries (it made none). See [Provider retries and fallback](./configuration.md#provider-retries-and-fallback). | `retry: false` |
| A rate-limited call (a 429) has the code `LOUSHO_PROVIDER_RATE_LIMITED` instead of `LOUSHO_PROVIDER_REQUEST_FAILED`. An out-of-credit account (`insufficient_quota`, a 402) is the non-retryable category `quota-exceeded`. | no opt-out: match both codes |
| The built-in providers' `timeout` is applied: 10 minutes by default, for the wait for a response to start and between two chunks. See [Request timeout](./providers.md#request-timeout). | `timeout: 0` (or `Infinity`) |
| `OpenAIProvider` sends `store: false` on the Responses API. See [OpenAI response storage](./providers.md#openai-response-storage-store). | `store: true` |
| A user file part the provider cannot send rejects the call with `LOUSHO_UNSUPPORTED_CONTENT` instead of a `[file ... not sent]` note. See [Multimodal input](./providers.md#multimodal-input). | `unsupportedFiles: 'text-note'` |
| `LLMProviderConfig` has no index signature: a misspelled option is a type error. | extend the interface for a custom provider's own fields |
| A 200 response that carries a failure (`finish_reason: "error"`, an `error` chunk) fails the call with a retryable error instead of succeeding with truncated text; an unknown finish reason is `'other'`, and `ExecutionFinishReason` is a closed union. | no opt-out |
| An aborted run ends `finishReason: 'aborted'` at once, even when the provider ignores the signal. See [Cancellation](./runs.md#cancellation). | no opt-out |
| The `openrouter` provider created without `apiKey` reads `OPENROUTER_API_KEY` (it sent `OPENAI_API_KEY`). | pass `apiKey` |
| The `@modelcontextprotocol/sdk` peer range is `^1.31.0`. | no opt-out |

### Tools, MCP and tracing

| Change | Opt-out |
| ------ | ------- |
| MCP tools ask for approval by default (`approval: 'always'`); an MCP tool whose name equals a local tool's is refused. See [Approval for MCP tools](./mcp.md#approval-for-mcp-tools). | `approval: 'annotations'` on servers you trust |
| Tool results are capped at 50,000 characters (head and tail kept). | `maxToolResultChars: Infinity` |
| `defineTool()` throws `LOUSHO_CONFIG_INVALID` for a non-object `input` root or a `z.date()` / `z.bigint()` field; tool-call arguments that are not valid JSON reach the model as `LOUSHO_TOOL_ARGS_INVALID` instead of running the tool with `{}`. | no opt-out |
| A flow `toolCall` step passes the agent's gate (`permissions`, `permissionMode`, approval) and validates its arguments; a call that needs approval fails with `LOUSHO_FLOW_TOOL_DENIED` without `approve`. See [Flows](./flows.md#tool-calls). | pass `approve` in the flow context |
| `createShellTool` `allow` string patterns refuse arguments that leave the workspace (`..`, `~`, absolute paths), also through quotes. | an `allow` `CommandRule` with an `args` check |
| `SubprocessSandbox` writes only under `root` and runs containers as `1000:1000` with all capabilities dropped. See [Sandboxed tools](./guardrails.md#sandboxed-tools). | `root`, `user: 'root'` |
| An MCP result made only of text reaches the model as `{ "text": ... }`. | no opt-out |
| `redactContent` defaults to `true`: the deprecated `input` / `prompt` / `args` / `result` span attributes are left out, so `fileTraceExporter()` files hold no content. See [Observability](./observability.md#message-and-argument-content-is-opt-in). | `redactContent: false` (or `captureContent: true` for the `gen_ai.*` content) |
| `agent.stream()` rethrows the run's error after the `error` and `run.done` events. See [Streaming](./streaming.md). | `stream(input, { throwOnError: false })` |
| `send([])` throws `LOUSHO_CONFIG_INVALID`. | no opt-out |

### CLI, evals and Agent Forge

| Change | Opt-out |
| ------ | ------- |
| `lousho dev`, `chat`, `acp`, `mcp`, `doctor`, `eval` and `build` load `./.env` when it exists; variables already set win. See [CLI](./cli.md). | remove or rename `.env` |
| Every `lousho` usage error (unknown command or flag, bad value, extra argument) exits 2; 1 means the command ran and failed. See [CLI](./cli.md). | check for a non-zero exit instead of exactly 1 |
| `t.maxCostUsd(n)` fails when a run reports no cost (the model has no known price). See [Evals](./evals.md). | `t.maxCostUsd(n, { unknownCost: 'skip' })` |
| `lousho eval` gives each live, `--record` and `--drift` case 10 minutes instead of vitest's 5 s. See [Time limits](./evals.md#time-limits). | `--timeout <ms>` or `defineEval({ timeoutMs })` |
| Agent Forge fails a run on a real provider with no API key (`LOUSHO_PROVIDER_MISSING_API_KEY`) instead of silently using the mock provider. | switch the agent's provider to `mock` |
| The npm package no longer ships `llms-full.txt` (it stays in the repository; `llms.txt` ships). | fetch `llms-full.txt` from the repository |

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
