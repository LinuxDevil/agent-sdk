# Errors

Every error the SDK throws on purpose is an `SDKError` (or a subclass such as
`ConfigurationError`, `ValidationError` or `MissingPeerDependencyError`) with:

- `code`: a stable string, `LOUSHY_<AREA>_<NAME>`. Branch on it, not on the
  message text, which may get clearer over time.
- `hint`: one sentence on how to fix it.
- `docs`: a link to the code's section on this page.

The message ends with the same information on its own line, so an uncaught
error tells you what to do:

```text
ConfigurationError: createAgent: no model configured. Do one of the following: (1) pass a model: ...
[LOUSHY_CONFIG_MISSING_PROVIDER] Pass a model string such as createAgent({ model: 'openai/gpt-4o-mini' }), a provider instance, or set LOUSHY_MODEL or a provider API key. (https://github.com/LinuxDevil/agent-sdk/blob/main/docs/errors.md#loushy_config_missing_provider)
```

`error.detail` is the message without that line. Tool and provider errors
(`ToolExecutionError`, `LLMProviderError`, `TimeoutError`, `RateLimitError`)
keep their message as it was, because the model sees it as a tool result or a
compacted provider error; their `toString()` still adds the line.

```ts
import { createAgent, SDKError } from '@loushy/build-ai-agent';

try {
  await createAgent({ provider, instructions: 'Be brief.' }).send('hi');
} catch (error) {
  if (error instanceof SDKError && error.code === 'LOUSHY_SESSION_AWAITING_APPROVAL') {
    console.log(error.hint, error.docs);
  } else {
    throw error;
  }
}
```

`ERROR_CODES` (exported) maps every code to its hint. A test keeps it, the codes
used in the source and the sections below in sync. Errors that are not on this
page yet (some runtime errors still throw a plain `Error`) will get a code in a
later release.

## Configuration

### LOUSHY_CONFIG_INVALID

**Means:** an option or argument has a value the SDK cannot use. This is the
default code of `ConfigurationError`; `error.field` names the option when known.

**Fix:** change the option the message names.

**Example:** `withFallback([])` throws "withFallback() needs at least one provider".

### LOUSHY_CONFIG_MISSING_PROVIDER

**Means:** there is no model to run: `createAgent()` got no `model` or
`provider` and found nothing in the environment, or `AgentExecutor.execute()` /
`stream()` got no `provider`.

**Fix:** pass `model: 'openai/gpt-4o-mini'` (any `<provider>/<model>`), pass a
`provider` instance, or set `LOUSHY_MODEL` or a provider key such as
`OPENAI_API_KEY`. See [Providers](./providers.md).

**Example:** `createAgent({ instructions: 'x' })` with no provider env var set.

### LOUSHY_CONFIG_MISSING_AGENT

**Means:** `AgentExecutor.execute()` / `stream()` was called without `agent`.

**Fix:** pass the agent, e.g. `AgentBuilder.create().setName('a').build()`, or
use `createAgent()`, which needs no separate agent object.

**Example:** `AgentExecutor.execute({ input: 'hi', provider })`.

### LOUSHY_CONFIG_MISSING_INPUT

**Means:** `AgentExecutor.execute()` / `stream()` was called without `input`.

**Fix:** pass the user message as a string or a `Message[]`.

**Example:** `AgentExecutor.execute({ agent, provider })`.

### LOUSHY_CONFIG_CONFLICTING_OPTIONS

**Means:** two options that mean the same thing were both given.

**Fix:** keep one. For `createAgent()`, `prompt` is an alias of `instructions`:
keep `instructions`.

**Example:** `createAgent({ provider, instructions: 'a', prompt: 'b' })`.

### LOUSHY_CONFIG_MISSING_CHECKPOINT_STORE

**Means:** `send()` or `stream()` got a `sessionId`, which makes the run
durable, but the agent has no checkpoint store.

**Fix:** pass `createAgent({ store: memoryStore() })` (or a `SqliteStore`, or a
`store` with `checkpoints`), or drop `sessionId`. See
[Durable execution](./durable-execution.md).

**Example:** `createAgent({ provider }).send('hi', { sessionId: 'job-1' })`.

### LOUSHY_CONFIG_RESOLVER_FAILED

**Means:** a `createAgent()` option given as a function of the run (`model`,
`instructions` / `prompt` or `tools`) threw while the run's config was being
resolved. The run never started: `send()` rejects, `stream()` ends with an
`error` event, and a session's transcript is left as it was. `error.field`
names the option and `error.cause` is what the function threw.

**Fix:** fix the function named in the message. See
[Dynamic config](./api-overview.md#dynamic-config).

**Example:** `createAgent({ provider, model: ({ metadata }) => plans[metadata.plan].model })` with an unknown plan.

## Providers and peers

### LOUSHY_PROVIDER_SPEC_INVALID

**Means:** a model string is not `<provider>/<model>`.

**Fix:** write both parts, e.g. `'openai/gpt-4o-mini'` or
`'anthropic/claude-3-5-sonnet-latest'`.

**Example:** `resolveProvider('gpt-4o')`.

### LOUSHY_PROVIDER_UNKNOWN

**Means:** the provider prefix of a model string is not one the SDK knows. The
message lists the supported prefixes and suggests the closest one.

**Fix:** use a supported prefix (`openai`, `anthropic`, `openrouter`, `ollama`),
or pass your own `provider` instance.

**Example:** `createAgent({ model: 'opnai/gpt-4o' })` says "Did you mean 'openai/gpt-4o'?".

### LOUSHY_PROVIDER_MISSING_API_KEY

**Means:** the provider's credential env var (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) is not set.

**Fix:** set it, or pass a configured provider instance.

**Example:** `createAgent({ model: 'openai/gpt-4o-mini' })` without `OPENAI_API_KEY`.

### LOUSHY_PROVIDER_REQUEST_FAILED

**Means:** a model call failed (`LLMProviderError`, and
`CompactedLLMProviderError`, whose `compacted.category` says why:
`rate-limit`, `timeout`, `context-length-exceeded`, `auth-failure`, `unknown`).

**Fix:** for `auth-failure`, fix the API key; for `context-length-exceeded`,
shorten the conversation (see [Context compaction](./compaction.md)); for
transient failures, use `withRetry()` / `fallbackModels`
(see [Providers](./providers.md)).

**Example:** a 401 from the provider with a revoked key.

### LOUSHY_PROVIDER_RATE_LIMITED

**Means:** a `RateLimitError`: the provider throttled the caller.

**Fix:** retry after `error.retryAfter` seconds (`withRetry()` does this), or
send fewer requests.

**Example:** a 429 response.

### LOUSHY_PEER_MISSING

**Means:** a feature needs an optional package that is not installed
(`MissingPeerDependencyError`, or a provider's SDK such as `@ai-sdk/openai`).

**Fix:** run the `npm install` command in the message (also on
`error.installCommand`). See [Installation](./installation.md).

**Example:** `SubprocessSandbox` without `dockerode`:
`npm install dockerode@^5.0.1`.

## Agent spec files

### LOUSHY_SPEC_INVALID

**Means:** `loadSpec()` found fields that fail validation. Each problem is
listed as `'<path>': <problem>`, plus any top-level field that looks like a
typo, with a suggestion.

**Fix:** fix each listed field. See [Configuration](./configuration.md).

**Example:**

```text
loadSpec: 'agent.yaml' failed validation - 'prompt': AgentSpec validation failed: missing required field 'prompt'; unknown field 'promt' (did you mean 'prompt'?)
```

### LOUSHY_SPEC_UNKNOWN_FIELD

**Means:** the spec is otherwise valid, but a top-level field is a likely typo
of a spec field and would be ignored. Other unknown fields are still ignored.

**Fix:** rename it to the suggested field, or remove it.

**Example:** `tool: [http]` gives "unknown field 'tool' (did you mean 'tools'?)".

### LOUSHY_SPEC_UNSUPPORTED_FORMAT

**Means:** the spec file's extension is not `.yaml`, `.yml` or `.json`.

**Fix:** rename the file, or convert it.

**Example:** `loadSpec('agent.toml')`.

## Tools

### LOUSHY_TOOL_NOT_FOUND

**Means:** a spec's `tools` entry names a tool that is not a built-in tool.

**Fix:** use one of the tools the message lists, or build the agent with
`createAgent({ tools: [...] })` and your own tool. See [Tools](./tools.md).

**Example:** `tools: [not-a-real-tool]` in a spec.

### LOUSHY_TOOL_NEEDS_CREDENTIALS

**Means:** a spec names a tool (`github`, `jira`) that needs credentials an
agent spec has no field for.

**Fix:** build the agent with `createAgent()` and pass the configured tool, e.g.
from `createGitHubTools(config)`.

**Example:** `tools: [github]` in a spec.

### LOUSHY_TOOL_EXECUTION_FAILED

**Means:** a `ToolExecutionError` (or subclass, such as
`ToolArgumentsValidationError`). Inside a run the model gets it as a tool
result and the run carries on.

**Fix:** look at `error.toolName` and `error.cause`, and fix the tool or the
input it was given.

**Example:** a tool's `execute` threw.

### LOUSHY_REMOTE_AGENT_FAILED

**Means:** a `remoteAgent()` sub-agent could not deliver an answer: the
deployed agent was unreachable, answered 401 or another non-2xx status, sent a
malformed or unfinished stream, or its run ended in an error. The lead model
gets it as a structured tool error; the bearer token is never part of it.

**Fix:** read the message (it names the url and the remote session id); for a
401, fix the `auth` token; for a remote run error, look at the remote agent's
logs for that session.

**Example:** `remoteAgent({ url, auth: 'wrong-token' })` against a deployment
that sets `LOUSHY_API_TOKEN`.

## Approvals and sessions

### LOUSHY_APPROVAL_STORE_MISSING

**Means:** a tool that `needsApproval` was called in an
`AgentExecutor.execute()` run that has no `approvalStore` to pause in.

**Fix:** pass `approvalStore: new InMemoryApprovalStore()` (or a persistent
store), or use `createAgent()`, which has one by default. See
[Approvals](./approvals.md).

**Example:** `AgentExecutor.execute({ agent, input, provider, toolRegistry })`
with a `needsApproval` tool.

### LOUSHY_APPROVAL_NOT_FOUND

**Means:** `resumeAfterApproval()` or `agent.approvals.resolve()` got an id that
is not pending: unknown, or already resolved.

**Fix:** resolve an id from `agent.approvals.list()` (or the `approvalId` of the
paused result); each approval resolves once.

**Example:** calling `agent.approvals.resolve({ id, approved: true })` twice.

### LOUSHY_SESSION_AWAITING_APPROVAL

**Means:** a `SessionAwaitingApprovalError`: the session or `sessionId` run is
paused on an approval (`error.approvalId`), so it cannot take new input yet.

**Fix:** resolve the approval with `agent.approvals.resolve()` (or
`resumeAfterApproval()` with the same `checkpointStore`), then send again. See
[Durable execution](./durable-execution.md).

**Example:** `session.send('next')` while the previous turn waits on an approval.

### LOUSHY_SESSION_ID_INVALID

**Means:** a session id is not 1-128 characters of letters, digits, `_` and
`-` (ids become file names, so `../` and `/` are refused).

**Fix:** use an id such as `'user-42'`, or omit it to get a generated one.

**Example:** `agent.session({ id: '../etc' })`.

### LOUSHY_SESSION_FILE_CORRUPT

**Means:** a `FileSessionStore` file is not a JSON array of messages.

**Fix:** restore the file from a backup, or delete it to start the session over.

**Example:** `sessions/user-42.json` containing `{}`.

### LOUSHY_SESSION_STREAM_UNSUPPORTED

**Means:** `stream()` was called on an `AgentSession` built by hand without a
streaming runner.

**Fix:** get the session from `agent.session()`, which can stream, or call
`send()`.

**Example:** `new AgentSession(run).stream('hi')`.

### LOUSHY_REMOTE_UNAUTHORIZED

**Means:** `loushy eval --url` (or `remoteTarget()`) got `401` from the deployed
agent: the bearer token is missing or wrong. The case fails; the run goes on.

**Fix:** pass the deployment's `LOUSHY_API_TOKEN` with `--token` or the
`LOUSHY_EVAL_TOKEN` environment variable. See
[Run evals against a deployment](./evals.md#run-evals-against-a-deployment).

**Example:** `loushy eval --url https://agent.example.com` against a deployment with a token set.

### LOUSHY_REMOTE_REQUEST_FAILED

**Means:** a remote eval case could not run: the deployment was unreachable,
answered with a non-2xx status, or its event stream was truncated (no
`run.done`).

**Fix:** check the URL, `GET <url>/health` and the deployment's logs.

**Example:** `loushy eval --url http://localhost:1` with nothing listening.

### LOUSHY_CHECKPOINT_NOT_FOUND

**Means:** `AgentExecutor.fork()` or `agent.fork()` was asked for a step the
session's checkpoint history does not have: the session is unknown, the step
was never reached, or its entries were dropped past the store's `historyLimit`.
The message lists the steps that are kept.

**Fix:** fork at one of the listed steps, or raise `historyLimit` on the store.
See [Durable execution](./durable-execution.md#fork-and-replay).

**Example:** `agent.fork('job-1', { fromStep: 9 })` after a 3-step run.

### LOUSHY_RUN_ALREADY_ITERATED

**Means:** an `AgentRun` from `session.stream()` was iterated a second time.

**Fix:** collect the events in the first `for await` loop, or call `stream()`
again for a new run. See [Streaming](./streaming.md).

**Example:** two `for await (const event of run)` loops over the same `run`.

## Schedules

### LOUSHY_SCHEDULE_INVALID

**Means:** `defineSchedule()` was given an invalid definition: a cron expression
that does not parse (the message names the field), or not exactly one of
`prompt` and `run`. Agent directories hit this while loading `schedules/`.

**Fix:** correct the expression or give the schedule one of `prompt` / `run`.
See [Schedules](./schedules.md).

**Example:** `defineSchedule({ cron: '61 * * * *', prompt: 'hi' })`.

## Channels

### LOUSHY_CHANNEL_INVALID

**Means:** a file in an agent directory's `channels/` folder does not default-export
a channel (an object with `parse` and `reply`). The message names the file.

**Fix:** default-export a channel made with `defineChannel()`, `httpChannel()`,
`webhookChannel()` or `slackChannel()`. See [Channels](./channels.md).

**Example:** `export default { cron: 'x' }` in `channels/sms.ts`.

## General

### LOUSHY_GENERIC_ERROR

**Means:** an `SDKError` created without a code.

**Fix:** read the message; it says what failed.

**Example:** `new SDKError('Something failed')`.

### LOUSHY_AGENT_EXECUTION_FAILED

**Means:** an `AgentExecutionError`: running an agent failed.

**Fix:** look at `error.cause` for the underlying failure.

**Example:** `new AgentExecutionError('Agent failed', agentId, cause)`.

### LOUSHY_FLOW_EXECUTION_FAILED

**Means:** a `FlowExecutionError`: a flow step failed.

**Fix:** look at `error.step` and `error.cause`. See [Flows](./flows.md).

**Example:** a flow step whose agent threw.

### LOUSHY_VALIDATION_FAILED

**Means:** a `ValidationError`: input failed validation.

**Fix:** fix the fields listed in `error.errors`.

**Example:** `new ValidationError('Validation failed', { email: ['Invalid email'] })`.

### LOUSHY_OPERATION_TIMEOUT

**Means:** a `TimeoutError`: an operation (`error.operation`) did not finish
within `error.timeoutMs`.

**Fix:** raise the timeout, or make the operation faster.

**Example:** `retryWithTimeout()` whose operation takes longer than its timeout.

### LOUSHY_OUTPUT_INVALID

**Means:** reserved. An invalid structured-output reply is not thrown today: the
run ends with `finishReason: 'output-invalid'` and `outputError`.

**Fix:** see [Structured output](./structured-output.md).

**Example:** a reply that does not match `output: zodSchema` after the repair step.

### LOUSHY_BUDGET_EXCEEDED

**Means:** a run's or a session's `limits` budget (`maxTokens`, `maxCostUsd`,
`maxDurationMs`, ...) tripped under `onExceeded: 'throw'`. `BudgetExceededError`
carries `budget: { limit, value, max, scope }`. With the default
`onExceeded: 'stop'` nothing is thrown: the run ends with
`finishReason: 'budget-exceeded'`.

**Fix:** raise the limit named in the message, or drop `onExceeded: 'throw'`.
See [Budgets](./configuration.md#budgets).

**Example:** `createAgent({ provider, limits: { maxCostUsd: 0.01, onExceeded: 'throw' } })` whose run costs more than a cent.

### LOUSHY_GUARDRAIL_TRIPPED

**Means:** an input, output or tool guardrail blocked a run under
`onTripped: 'throw'`. `GuardrailError` carries
`guardrail: { name, kind, reason, toolName? }`. With the default
`onTripped: 'stop'` nothing is thrown: the run ends with
`finishReason: 'guardrail'`.

**Fix:** look at `error.guardrail` for which guardrail blocked and why, or drop
`onTripped: 'throw'`. See [Input and output guardrails](./guardrails.md#input-and-output-guardrails).

**Example:** `createAgent({ provider, guardrails: { input: [maxLengthGuardrail({ maxChars: 10 })], onTripped: 'throw' } })` sent a longer message.
