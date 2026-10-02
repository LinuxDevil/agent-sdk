# Errors

Every error the SDK throws on purpose is an `SDKError` (or a subclass such as
`ConfigurationError`, `ValidationError` or `MissingPeerDependencyError`) with:

- `code`: a stable string, `LOUSHO_<AREA>_<NAME>`. Branch on it, not on the
  message text, which may get clearer over time.
- `hint`: one sentence on how to fix it.
- `docs`: a link to the code's section on this page.

The message ends with the same information on its own line, so an uncaught
error tells you what to do:

```text
ConfigurationError: createAgent: no model configured. Do one of the following: (1) pass a model: ...
[LOUSHO_CONFIG_MISSING_PROVIDER] Pass a model string such as createAgent({ model: 'openai/gpt-4o-mini' }), a provider instance, or set LOUSHO_MODEL or a provider API key. (https://github.com/LinuxDevil/agent-sdk/blob/main/docs/errors.md#lousho_config_missing_provider)
```

`error.detail` is the message without that line. Tool and provider errors
(`ToolExecutionError`, `LLMProviderError`, `TimeoutError`, `RateLimitError`)
keep their message as it was, because the model sees it as a tool result or a
compacted provider error; their `toString()` still adds the line.

```ts
import { createAgent, SDKError } from '@lousho/build-ai-agent';

try {
  await createAgent({ provider, instructions: 'Be brief.' }).send('hi');
} catch (error) {
  if (error instanceof SDKError && error.code === 'LOUSHO_SESSION_AWAITING_APPROVAL') {
    console.log(error.hint, error.docs);
  } else {
    throw error;
  }
}
```

`ERROR_CODES` (exported) maps every code to its hint. A test keeps it, the codes
used in the source and the sections below in sync. A second test fails when new
SDK code throws a plain `Error` instead of an `SDKError`; the few plain ones left
are internal and listed in `src/utils/plainErrors.test.ts` with the reason for each.

To start from a symptom instead of a code, see [Troubleshooting](./troubleshooting.md).

Find a code by area:

| Area | Codes | When you meet them |
| ---- | ----- | ------------------ |
| [Configuration](#configuration) | [`LOUSHO_CONFIG_INVALID`](#lousho_config_invalid), [`LOUSHO_CONFIG_MISSING_PROVIDER`](#lousho_config_missing_provider), [`LOUSHO_CONFIG_MISSING_AGENT`](#lousho_config_missing_agent), [`LOUSHO_CONFIG_MISSING_INPUT`](#lousho_config_missing_input), [`LOUSHO_CONFIG_CONFLICTING_OPTIONS`](#lousho_config_conflicting_options), [`LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE`](#lousho_config_missing_checkpoint_store), [`LOUSHO_CONFIG_RESOLVER_FAILED`](#lousho_config_resolver_failed) | A `createAgent()` or executor call that is missing or mixing options, or a config resolver that failed. |
| [Providers and peers](#providers-and-peers) | [`LOUSHO_PROVIDER_SPEC_INVALID`](#lousho_provider_spec_invalid), [`LOUSHO_PROVIDER_UNKNOWN`](#lousho_provider_unknown), [`LOUSHO_PROVIDER_MISSING_API_KEY`](#lousho_provider_missing_api_key), [`LOUSHO_PROVIDER_REQUEST_FAILED`](#lousho_provider_request_failed), [`LOUSHO_PROVIDER_RATE_LIMITED`](#lousho_provider_rate_limited), [`LOUSHO_PEER_MISSING`](#lousho_peer_missing), [`LOUSHO_HOSTED_TOOL_UNSUPPORTED`](#lousho_hosted_tool_unsupported) | Resolving a model string, a missing API key or peer package, a failed or rate-limited model request, a hosted tool the provider cannot run. |
| [Agent spec files](#agent-spec-files) | [`LOUSHO_SPEC_INVALID`](#lousho_spec_invalid), [`LOUSHO_SPEC_UNKNOWN_FIELD`](#lousho_spec_unknown_field), [`LOUSHO_SPEC_UNSUPPORTED_FORMAT`](#lousho_spec_unsupported_format) | Loading an `AgentSpec` file with `loadSpec()` or `specToAgent()`. |
| [Tools](#tools) | [`LOUSHO_TOOL_NOT_FOUND`](#lousho_tool_not_found), [`LOUSHO_TOOL_NEEDS_CREDENTIALS`](#lousho_tool_needs_credentials), [`LOUSHO_TOOL_EXECUTION_FAILED`](#lousho_tool_execution_failed), [`LOUSHO_TOOL_ARGS_INVALID`](#lousho_tool_args_invalid) | A tool the model called is unknown, needs credentials, threw, or got invalid arguments. |
| [Approvals and sessions](#approvals-and-sessions) | [`LOUSHO_APPROVAL_STORE_MISSING`](#lousho_approval_store_missing), [`LOUSHO_APPROVAL_NOT_FOUND`](#lousho_approval_not_found), [`LOUSHO_SESSION_AWAITING_APPROVAL`](#lousho_session_awaiting_approval), [`LOUSHO_SESSION_ID_INVALID`](#lousho_session_id_invalid), [`LOUSHO_SESSION_FILE_CORRUPT`](#lousho_session_file_corrupt), [`LOUSHO_SESSION_BUSY`](#lousho_session_busy), [`LOUSHO_SESSION_TURN_PENDING`](#lousho_session_turn_pending), [`LOUSHO_SESSION_STREAM_UNSUPPORTED`](#lousho_session_stream_unsupported), [`LOUSHO_SESSION_STEP_NOT_FOUND`](#lousho_session_step_not_found), [`LOUSHO_SESSION_EXISTS`](#lousho_session_exists), [`LOUSHO_SESSION_FORK_UNSUPPORTED`](#lousho_session_fork_unsupported), [`LOUSHO_REMOTE_UNAUTHORIZED`](#lousho_remote_unauthorized), [`LOUSHO_REMOTE_REQUEST_FAILED`](#lousho_remote_request_failed), [`LOUSHO_SUBAGENT_TASK_NOT_FOUND`](#lousho_subagent_task_not_found), [`LOUSHO_SUBAGENT_TASK_BUSY`](#lousho_subagent_task_busy), [`LOUSHO_CHECKPOINT_NOT_FOUND`](#lousho_checkpoint_not_found), [`LOUSHO_AGENT_DRIFT`](#lousho_agent_drift), [`LOUSHO_RESUME_TOOL_MISSING`](#lousho_resume_tool_missing), [`LOUSHO_RUN_ALREADY_ITERATED`](#lousho_run_already_iterated) | Approvals, sessions, checkpoints and resume, remote agents and sub-agent tasks. |
| [Schedules](#schedules) | [`LOUSHO_SCHEDULE_INVALID`](#lousho_schedule_invalid) | Defining or loading a schedule. |
| [Channels](#channels) | [`LOUSHO_CHANNEL_INVALID`](#lousho_channel_invalid), [`LOUSHO_MEMORY_INVALID`](#lousho_memory_invalid) | Defining a channel or a memory slot. |
| [Registry](#registry) | [`LOUSHO_REGISTRY_UNREACHABLE`](#lousho_registry_unreachable), [`LOUSHO_REGISTRY_ITEM_NOT_FOUND`](#lousho_registry_item_not_found), [`LOUSHO_REGISTRY_INVALID`](#lousho_registry_invalid), [`LOUSHO_REGISTRY_UNSAFE_PATH`](#lousho_registry_unsafe_path), [`LOUSHO_REGISTRY_FILE_EXISTS`](#lousho_registry_file_exists) | `lousho add` fetching or copying from a registry. |
| [Sandbox](#sandbox) | [`LOUSHO_SANDBOX_EGRESS_UNSUPPORTED`](#lousho_sandbox_egress_unsupported) | Asking a sandbox for something it cannot do on the current platform. |
| [Agent directories, skills and flows](#agent-directories-skills-and-flows) | [`LOUSHO_AGENT_DIR_INVALID`](#lousho_agent_dir_invalid), [`LOUSHO_SKILL_INVALID`](#lousho_skill_invalid), [`LOUSHO_FLOW_INVALID`](#lousho_flow_invalid) | Loading an agent directory, a skill, or a flow definition. |
| [Storage, deployment and integrations](#storage-deployment-and-integrations) | [`LOUSHO_STORAGE_FAILED`](#lousho_storage_failed), [`LOUSHO_TRIGGER_INVALID`](#lousho_trigger_invalid), [`LOUSHO_CHANNEL_REQUEST_FAILED`](#lousho_channel_request_failed), [`LOUSHO_DEPLOY_FAILED`](#lousho_deploy_failed) | A storage backend, a trigger, a channel request or `lousho build`. |
| [Tests and evals](#tests-and-evals) | [`LOUSHO_EVALS_INVALID`](#lousho_evals_invalid), [`LOUSHO_TEST_FAILED`](#lousho_test_failed), [`LOUSHO_CASSETTE_INVALID`](#lousho_cassette_invalid) | `defineEval()`, `mockModel` and cassettes. |
| [General](#general) | [`LOUSHO_GENERIC_ERROR`](#lousho_generic_error), [`LOUSHO_AGENT_EXECUTION_FAILED`](#lousho_agent_execution_failed), [`LOUSHO_FLOW_EXECUTION_FAILED`](#lousho_flow_execution_failed), [`LOUSHO_VALIDATION_FAILED`](#lousho_validation_failed), [`LOUSHO_OPERATION_TIMEOUT`](#lousho_operation_timeout), [`LOUSHO_OUTPUT_INVALID`](#lousho_output_invalid), [`LOUSHO_BUDGET_EXCEEDED`](#lousho_budget_exceeded), [`LOUSHO_GUARDRAIL_TRIPPED`](#lousho_guardrail_tripped) | Run-level failures: a timeout, a budget or guardrail stop, invalid output, and the catch-all codes. |
| [OAuth](#oauth) | [`LOUSHO_TOKEN_KEY_MISSING`](#lousho_token_key_missing), [`LOUSHO_TOKEN_DECRYPT_FAILED`](#lousho_token_decrypt_failed) | Storing or reading OAuth tokens in a file, SQLite or KV store. |

## Configuration

### LOUSHO_CONFIG_INVALID

**Means:** an option or argument has a value the SDK cannot use. This is the
default code of `ConfigurationError`; `error.field` names the option when known.

**Fix:** change the option the message names.

**Example:** `withFallback([])` throws "withFallback() needs at least one provider".
`new NodeWorkspace({ root })` with a missing or non-directory root, a duplicate tool
name in a `ToolRegistry`, a bad `toolConcurrency`, `serveMcp()` without a `name`
and `lousho studio` without Agent Forge's files are the same code.

### LOUSHO_CONFIG_MISSING_PROVIDER

**Means:** there is no model to run: `createAgent()` got no `model` or
`provider` and found nothing in the environment, or `AgentExecutor.execute()` /
`stream()` got no `provider`.

**Fix:** pass `model: 'openai/gpt-4o-mini'` (any `<provider>/<model>`), pass a
`provider` instance, or set `LOUSHO_MODEL` or a provider key such as
`OPENAI_API_KEY`. See [Providers](./providers.md).

**Example:** `createAgent({ instructions: 'x' })` with no provider env var set.

### LOUSHO_CONFIG_MISSING_AGENT

**Means:** `AgentExecutor.execute()` / `stream()` was called without `agent`.

**Fix:** pass the agent, e.g. `AgentBuilder.create().setName('a').build()`, or
use `createAgent()`, which needs no separate agent object.

**Example:** `AgentExecutor.execute({ input: 'hi', provider })`.

### LOUSHO_CONFIG_MISSING_INPUT

**Means:** `AgentExecutor.execute()` / `stream()` was called without `input`.

**Fix:** pass the user message as a string or a `Message[]`.

**Example:** `AgentExecutor.execute({ agent, provider })`.

### LOUSHO_CONFIG_CONFLICTING_OPTIONS

**Means:** two options that mean the same thing were both given.

**Fix:** keep one. For `createAgent()`, `prompt` is an alias of `instructions`:
keep `instructions`.

**Example:** `createAgent({ provider, instructions: 'a', prompt: 'b' })`.

### LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE

**Means:** `send()` or `stream()` got a `sessionId`, which makes the run
durable, but the agent has no checkpoint store.

**Fix:** pass `createAgent({ store: memoryStore() })` (or a `SqliteStore`, or a
`store` with `checkpoints`), or drop `sessionId`. See
[Durable execution](./durable-execution.md).

**Example:** `createAgent({ provider }).send('hi', { sessionId: 'job-1' })`.

### LOUSHO_CONFIG_RESOLVER_FAILED

**Means:** a `createAgent()` option given as a function of the run (`model`,
`instructions` / `prompt` or `tools`) threw while the run's config was being
resolved. The run never started: `send()` rejects, `stream()` ends with an
`error` event, and a session's transcript is left as it was. `error.field`
names the option and `error.cause` is what the function threw.

**Fix:** fix the function named in the message. See
[Dynamic config](./api-overview.md#dynamic-config).

**Example:** `createAgent({ provider, model: ({ metadata }) => plans[metadata.plan].model })` with an unknown plan.

## Providers and peers

### LOUSHO_PROVIDER_SPEC_INVALID

**Means:** a model string is not `<provider>/<model>`.

**Fix:** write both parts, e.g. `'openai/gpt-4o-mini'` or
`'anthropic/claude-3-5-sonnet-latest'`.

**Example:** `resolveProvider('gpt-4o')`.

### LOUSHO_PROVIDER_UNKNOWN

**Means:** the provider prefix of a model string is not one the SDK knows. The
message lists the supported prefixes and suggests the closest one.

**Fix:** use a supported prefix (`openai`, `anthropic`, `openrouter`, `ollama`),
or pass your own `provider` instance.

**Example:** `createAgent({ model: 'opnai/gpt-4o' })` says "Did you mean 'openai/gpt-4o'?".

### LOUSHO_PROVIDER_MISSING_API_KEY

**Means:** the provider's credential env var (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) is not set.

**Fix:** set it, or pass a configured provider instance.

**Example:** `createAgent({ model: 'openai/gpt-4o-mini' })` without `OPENAI_API_KEY`.

### LOUSHO_PROVIDER_REQUEST_FAILED

**Means:** a model call failed (`LLMProviderError`, and
`CompactedLLMProviderError`, whose `compacted.category` says why:
`rate-limit`, `timeout`, `context-length-exceeded`, `auth-failure`, `unknown`).

**Fix:** for `auth-failure`, fix the API key; for `context-length-exceeded`,
shorten the conversation (see [Context compaction](./compaction.md)); for
transient failures, use `withRetry()` / `fallbackModels`
(see [Providers](./providers.md)).

**Example:** a 401 from the provider with a revoked key.

### LOUSHO_PROVIDER_RATE_LIMITED

**Means:** a `RateLimitError`: the provider throttled the caller.

**Fix:** retry after `error.retryAfter` seconds (`withRetry()` does this), or
send fewer requests.

**Example:** a 429 response.

### LOUSHO_PEER_MISSING

**Means:** a feature needs an optional package that is not installed
(`MissingPeerDependencyError`, or a provider's SDK such as `@ai-sdk/openai`).

**Fix:** run the `npm install` command in the message (also on
`error.installCommand`). See [Installation](./installation.md).

**Example:** `SubprocessSandbox` without `dockerode`:
`npm install dockerode@^5.0.1`.

### LOUSHO_HOSTED_TOOL_UNSUPPORTED

**Means:** an agent has a hosted tool (`webSearch()`, `codeInterpreter()`,
`fileSearch()` or `hostedTool()`) that its provider cannot send: the provider
has no hosted tools (Ollama, a custom `LLMProvider` without
`supportsHostedTool()`), `ai` 4 is installed (hosted tools need `ai` 6 or 7), or
the installed provider package has no such tool. The message names the
provider, the tool and what would work.

**Fix:** run the tool on a provider and package pairing that supports it (see
[Hosted provider tools](./hosted-tools.md)), or leave it out of `tools` for
this provider.

**Example:** `createAgent({ model: 'ollama/llama3.2', tools: [webSearch()] })`
rejects its first `send()`.

## Agent spec files

### LOUSHO_SPEC_INVALID

**Means:** `loadSpec()` found fields that fail validation. Each problem is
listed as `'<path>': <problem>`, plus any top-level field that looks like a
typo, with a suggestion.

**Fix:** fix each listed field. See [Configuration](./configuration.md).

**Example:**

```text
loadSpec: 'agent.yaml' failed validation - 'prompt': AgentSpec validation failed: missing required field 'prompt'; unknown field 'promt' (did you mean 'prompt'?)
```

### LOUSHO_SPEC_UNKNOWN_FIELD

**Means:** the spec is otherwise valid, but a top-level field is a likely typo
of a spec field and would be ignored. Other unknown fields are still ignored.

**Fix:** rename it to the suggested field, or remove it.

**Example:** `tool: [http]` gives "unknown field 'tool' (did you mean 'tools'?)".

### LOUSHO_SPEC_UNSUPPORTED_FORMAT

**Means:** the spec file's extension is not `.yaml`, `.yml` or `.json`.

**Fix:** rename the file, or convert it.

**Example:** `loadSpec('agent.toml')`.

## Tools

### LOUSHO_TOOL_NOT_FOUND

**Means:** a spec's `tools` entry names a tool that is not a built-in tool.

**Fix:** use one of the tools the message lists, or build the agent with
`createAgent({ tools: [...] })` and your own tool. See [Tools](./tools.md).

**Example:** `tools: [not-a-real-tool]` in a spec.

### LOUSHO_TOOL_NEEDS_CREDENTIALS

**Means:** a spec names a tool (`github`, `jira`) that needs credentials an
agent spec has no field for.

**Fix:** build the agent with `createAgent()` and pass the configured tool, e.g.
from `createGitHubTools(config)`.

**Example:** `tools: [github]` in a spec.

### LOUSHO_TOOL_EXECUTION_FAILED

**Means:** a `ToolExecutionError` (or subclass, such as
`ToolArgumentsValidationError`). Inside a run the model gets it as a tool
result and the run carries on.

**Fix:** look at `error.toolName` and `error.cause`, and fix the tool or the
input it was given.

**Example:** a tool's `execute` threw. The built-in tools (`http`, `email`,
`github`, `jira`, `slack`, `ask_question`) throw an `SDKError` with this code for
a failed call; their message is the tool's result, so it carries no appended
`[code] hint (docs)` line.

### LOUSHO_TOOL_ARGS_INVALID

**Means:** the model called a tool with arguments that do not match its input
schema (a `ToolArgumentsValidationError`). Inside a run the model gets the
issues as a tool result and can retry, so a run seldom ends on it.

**Fix:** if you called the tool yourself, fix the arguments named in the message;
if the model keeps getting them wrong, make the field `.describe()`
text clearer. `error.issues` lists each path and problem. See [Tools](./tools.md).

**Example:** the model sends `{ to: 42 }` to a tool whose `to` is a string.

## Approvals and sessions

### LOUSHO_APPROVAL_STORE_MISSING

**Means:** a tool that `needsApproval` was called in an
`AgentExecutor.execute()` run that has no `approvalStore` to pause in.

**Fix:** pass `approvalStore: new InMemoryApprovalStore()` (or a persistent
store), or use `createAgent()`, which has one by default. See
[Approvals](./approvals.md).

**Example:** `AgentExecutor.execute({ agent, input, provider, toolRegistry })`
with a `needsApproval` tool.

### LOUSHO_APPROVAL_NOT_FOUND

**Means:** `resumeAfterApproval()` or `agent.approvals.resolve()` got an id that
is not pending: unknown, or already resolved.

**Fix:** resolve an id from `agent.approvals.list()` (or the `approvalId` of the
paused result); each approval resolves once.

**Example:** calling `agent.approvals.resolve({ id, approved: true })` twice.

### LOUSHO_SESSION_AWAITING_APPROVAL

**Means:** a `SessionAwaitingApprovalError`: the session or `sessionId` run is
paused on an approval (`error.approvalId`), so it cannot take new input yet.

**Fix:** resolve the approval with `agent.approvals.resolve()` (or
`resumeAfterApproval()` with the same `checkpointStore`), then send again. See
[Durable execution](./durable-execution.md).

**Example:** `session.send('next')` while the previous turn waits on an approval.

### LOUSHO_SESSION_ID_INVALID

**Means:** a session id is not 1-128 characters of letters, digits, `_` and
`-` (ids become file names, so `../` and `/` are refused).

**Fix:** use an id such as `'user-42'`, or omit it to get a generated one.

**Example:** `agent.session({ id: '../etc' })`.

### LOUSHO_SESSION_FILE_CORRUPT

**Means:** a `FileSessionStore` file is not a JSON array of messages.

**Fix:** restore the file from a backup, or delete it to start the session over.

**Example:** `sessions/user-42.json` containing `{}`.

### LOUSHO_SESSION_BUSY

**Means:** `session.compact()`, `session.clear()` or `session.fork()` was called while a turn of
that session is running or queued.

**Fix:** await the turn's `send()` (or abort it), then call again.

### LOUSHO_SESSION_TURN_PENDING

**Means:** `session.compact()` was called while a durable session has an
interrupted turn, whose checkpoint is keyed by the transcript length.

**Fix:** finish it with `session.resume()` or drop it with
`session.discardPending()`, then call again.

### LOUSHO_SESSION_STREAM_UNSUPPORTED

**Means:** `stream()` was called on an `AgentSession` built by hand without a
streaming runner.

**Fix:** get the session from `agent.session()`, which can stream, or call
`send()`.

**Example:** `new AgentSession(run).stream('hi')`.

### LOUSHO_SESSION_STEP_NOT_FOUND

**Means:** `session.fork({ fromStep })` was given a step that is not an integer
from 0 to the number of steps in `session.history()`. The error is a
`ConfigurationError` (`field: 'fromStep'`) whose message lists the valid range.

**Fix:** pick a step from `session.history()`, or `0` to keep nothing.

**Example:** `session.fork({ fromStep: 9 })` on a session with three steps.

### LOUSHO_SESSION_EXISTS

**Means:** `session.fork({ id })` was given an id that already has a transcript
in the session's store (or a checkpointed turn the fork would pick up), or the
session's own id. The error is a `ConfigurationError` (`field: 'id'`).

**Fix:** pick an unused id, or leave `id` out to get `<id>-fork-<n>`.

**Example:** `session.fork({ fromStep: 1, id: session.id })`.

### LOUSHO_SESSION_FORK_UNSUPPORTED

**Means:** `fork()` was called on an `AgentSession` built by hand without the
function that creates sibling sessions.

**Fix:** get the session from `agent.session()`, which can fork.

**Example:** `new AgentSession(run).fork({ fromStep: 0 })`.

### LOUSHO_REMOTE_UNAUTHORIZED

**Means:** `lousho eval --url`, `remoteTarget()` or a `remoteAgent()` sub-agent
got `401` from the deployed agent: the bearer token is missing or wrong. An eval
case fails (the run goes on); the lead model gets a structured tool error. The
token is never part of the message.

**Fix:** pass the deployment's `LOUSHO_API_TOKEN` with `--token` or the
`LOUSHO_EVAL_TOKEN` environment variable. See
[Run evals against a deployment](./evals.md#run-evals-against-a-deployment).

**Example:** `lousho eval --url https://agent.example.com` against a deployment with a token set.

### LOUSHO_REMOTE_REQUEST_FAILED

**Means:** a remote eval case (`lousho eval --url`, `remoteTarget()`) or a
`remoteAgent()` task could not run: the deployment was unreachable, answered
with a non-2xx status, was aborted, or its event stream broke or was truncated
(no `run.done`). A `remoteAgent()` task whose remote run ends in an error also
fails with it, and the message says "the remote run ended in an error". The
lead model gets it as a structured tool error; the bearer token is never part
of it.

**Fix:** read the message (it names the url and, for a sub-agent, the remote
session id); check the URL, `GET <url>/health` and the deployment's logs.

**Example:** `lousho eval --url http://localhost:1` with nothing listening.

### LOUSHO_SUBAGENT_TASK_NOT_FOUND

**Means:** a `task` call asked to resume or fork a `taskId` that this lead
session has no conversation for (never started, started in another lead
session or run, or not finished), or that belongs to another sub-agent. The
lead model gets it as a structured tool error.

**Fix:** use a `taskId` from an earlier `task` result of the same lead
session, with the same `agent`; or omit `taskId` to start a new task. See
[Sub-agents](./sub-agents.md#continuing-a-task).

**Example:** `task({ agent: 'researcher', taskId: 'task_7', prompt })` when the
session has only `task_1`.

### LOUSHO_SUBAGENT_TASK_BUSY

**Means:** a `task` call asked to resume or fork a task whose sub-agent is
still running, for example a background task that has not ended.

**Fix:** wait for it with `agent_await` (or stop it with `agent_cancel`),
then continue it.

**Example:** `task({ agent: 'researcher', taskId: 'task_1', prompt })` right
after starting `task_1` with `background: true`.

### LOUSHO_CHECKPOINT_NOT_FOUND

**Means:** `AgentExecutor.fork()` or `agent.fork()` was asked for a step the
session's checkpoint history does not have: the session is unknown, the step
was never reached, or its entries were dropped past the store's `historyLimit`.
The message lists the steps that are kept.

**Fix:** fork at one of the listed steps, or raise `historyLimit` on the store.
See [Durable execution](./durable-execution.md#fork-and-replay).

**Example:** `agent.fork('job-1', { fromStep: 9 })` after a 3-step run.

### LOUSHO_AGENT_DRIFT

**Means:** a paused or interrupted run was resumed by an agent that differs
from the one that saved it, and `onAgentDrift` is `'error'`. The message names
what changed: the model, tools added, removed or with a changed input schema,
or the instructions. It is thrown before any model call or tool runs; the
checkpoint (and, for an approval, the pending record) is left as it was.

**Fix:** resume with the agent that paused the run, or set `onAgentDrift` to
`'warn'` (the default) or `'ignore'` to continue anyway. See
[Durable execution](./durable-execution.md#resuming-with-a-changed-agent).

**Example:** `createAgent({ store, onAgentDrift: 'error' })` after a deploy that
renamed a tool, then `agent.resume('job-1')`.

### LOUSHO_RESUME_TOOL_MISSING

**Means:** a resumed run is waiting on a tool call (an approved call, or a call
of the model's last turn that has no result yet) whose tool the resuming agent
no longer has. This is an error whatever `onAgentDrift` is, because the call
cannot run.

**Fix:** give the tool back under the same name, or drop the paused run (delete
its checkpoint, reject its approval). See
[Durable execution](./durable-execution.md#resuming-with-a-changed-agent).

**Example:** a run paused on `charge_card`, then a deploy removes that tool and
`agent.approvals.resolve({ id, approved: true })` is called.

### LOUSHO_RUN_ALREADY_ITERATED

**Means:** an `AgentRun` from `session.stream()` was iterated a second time.

**Fix:** collect the events in the first `for await` loop, or call `stream()`
again for a new run. See [Streaming](./streaming.md).

**Example:** two `for await (const event of run)` loops over the same `run`.

## Schedules

### LOUSHO_SCHEDULE_INVALID

**Means:** `defineSchedule()` was given an invalid definition: a cron expression
that does not parse (the message names the field), or not exactly one of
`prompt` and `run`. Agent directories hit this while loading `schedules/`.

**Fix:** correct the expression or give the schedule one of `prompt` / `run`.
See [Schedules](./schedules.md).

**Example:** `defineSchedule({ cron: '61 * * * *', prompt: 'hi' })`.

## Channels

### LOUSHO_CHANNEL_INVALID

**Means:** a file in an agent directory's `channels/` folder does not default-export
a channel (an object with `parse` and `reply`). The message names the file.

**Fix:** default-export a channel made with `defineChannel()`, `httpChannel()`,
`webhookChannel()`, `slackChannel()`, `discordChannel()`, `telegramChannel()`, `githubChannel()` or `teamsChannel()`. See [Channels](./channels.md).

**Example:** `export default { cron: 'x' }` in `channels/sms.ts`.

### LOUSHO_MEMORY_INVALID

**Means:** a file in an agent directory's `memory/` folder does not default-export
a memory slot (an object with a `scope` and a `provider`). The message names the file.

**Fix:** default-export `defineMemory({ ... })`, or the same options without a `name`
(the file name is used). See [Memory](./memory.md) and [Agent directories](./agent-directories.md#memory).

**Example:** `export default { cron: 'x' }` in `memory/notes.ts`.

## Registry

### LOUSHO_REGISTRY_UNREACHABLE

**Means:** `lousho add` could not read a registry document: the URL did not answer
in time or returned an error, the local file is missing, the scheme is not `http(s)`
or the document is larger than the cap.

**Fix:** check the `--registry` value (or `LOUSHO_REGISTRY`) and your connection.
See [Registry](./registry.md).

**Example:** `lousho add x --registry https://example.invalid/index.json`.

### LOUSHO_REGISTRY_ITEM_NOT_FOUND

**Means:** the registry's index has no item with that name. The message suggests the
closest name when there is one.

**Fix:** run `lousho add --list` and use one of the names.

**Example:** `lousho add web-serach` when the item is `web-search`.

### LOUSHO_REGISTRY_INVALID

**Means:** a registry index or item document is not valid JSON or does not match the
format (a missing field, an unknown item type, an item whose document names another item).

**Fix:** fix the document the message names. See [Registry](./registry.md#format).

**Example:** an item document without `files`.

### LOUSHO_REGISTRY_UNSAFE_PATH

**Means:** an item asks to write a file that is absolute, has `..`, backslashes or a
drive letter, is outside the folder its type may write to, resolves outside the agent
directory through a symlink, or is larger than the size caps. Nothing was written.

**Fix:** do not install the item; tell whoever hosts the registry.
See [Registry](./registry.md#safety-rules).

**Example:** a tool item with a file `../../.bashrc`.

### LOUSHO_REGISTRY_FILE_EXISTS

**Means:** a file the item would write already exists. Nothing was written.

**Fix:** pass `--overwrite`, or move your file away first.

**Example:** `lousho add web-search` twice.

### LOUSHO_REGISTRY_MANIFEST_MISMATCH

**Means:** an item's code reaches for something its permission manifest does not
declare: it imports `child_process` without `exec: true`, writes files without
`filesystem: "write"`, calls `fetch()` or names a URL host that is not in `network`,
reads an environment variable that is not in `env`, or uses `eval`, `new Function`,
a computed `process.env[...]` or a dynamic `import()` / `require()`, which are never
allowed. The message lists every finding as `<file>:<line>: <what> (<fix>)`. Nothing
was written. `--dry-run` reports it too.

**Fix:** do not install the item; tell whoever hosts the registry. Its author fixes
the code or declares the permission. See [Registry](./registry.md#permission-manifest).

**Example:** a tool item whose file imports `node:child_process` while its manifest
leaves `exec` out.

## Sandbox

### LOUSHO_SANDBOX_EGRESS_UNSUPPORTED

**Means:** a `SubprocessSandbox` with `network: { allow }` and a `broker` cannot make
the credential broker the container's only route out on this Docker daemon, so it
started no container instead of granting open egress. The message names the reason:
Docker Desktop (containers run in a VM, so the host has no address on the internal
network), rootless Docker, a daemon on another machine (the broker cannot listen on
the network's gateway), a reused network that is not internal, or an Engine older
than 25.0.5, which forwards DNS from internal networks.

**Fix:** run the agent on the Linux host of a Docker Engine 25.0.5 or later, or use
`network: 'none'`. See [Workspace tools](./workspace-tools.md#sandboxed-shell-sandboxshell).

**Example:** `new SubprocessSandbox({ network: { allow: ['api.github.com'] }, broker })` with Docker Desktop.

## Agent directories, skills and flows

### LOUSHO_AGENT_DIR_INVALID

**Means:** `loadAgentDir()` (or `lousho dev`, `lousho build`, which use it) could
not load a directory: it is missing or unreadable, a file is empty, a `tools/`
file has no usable export, a config file does not parse, or a sub-agent folder is
malformed. The message names the file.

**Fix:** correct the file the message names. See [Agent directories](./agent-directories.md).

**Example:** `loadAgentDir('./agents/support')` where `instructions.md` is empty.

### LOUSHO_SKILL_INVALID

**Means:** a skill is malformed (`defineSkill()`, a `skills/` folder) or
`withSkills()` was given duplicate names, or a skill name that collides with the
`load_skill` tool.

**Fix:** give each skill a unique name, a description and content; rename a tool called
`load_skill`. See [Skills](./skills.md).

**Example:** `defineSkill({ name: 'x', description: '', content: '...' })`.

### LOUSHO_FLOW_INVALID

**Means:** a flow definition is wrong: a missing or duplicate input name, a
missing flow name or code, or a node of an unknown type.

**Fix:** fix the part of the flow the message names. See [Flows](./flows.md).

**Example:** two `.input('city')` calls on one `FlowBuilder`.

## Storage, deployment and integrations

### LOUSHO_STORAGE_FAILED

**Means:** storage failed: a SQLite database could not be opened (the `cause`
has the driver's error), was used after `close()`, has a newer schema than this
SDK knows, or `node:sqlite` is missing; or a file exceeded the storage size limit.

**Fix:** check the path and permissions, use Node >= 22.5 for `SqliteStore` (or a
file-based store), and create a new store after closing one.

**Example:** `new SqliteStore('/read-only/agent.db')`.

### LOUSHO_TRIGGER_INVALID

**Means:** a trigger adapter got invalid options: a cron adapter without exactly
one of `intervalMs` / `cron`, a webhook `auth` block with an empty secret or an
unknown type, or a Slack trigger that cannot verify requests.

**Fix:** use the example in the message. See [Channels](./channels.md) and [Schedules](./schedules.md).

**Example:** `webhookTrigger({ auth: { type: 'hmac', secret: '' } })`.

### LOUSHO_CHANNEL_REQUEST_FAILED

**Means:** a call to a chat platform's API (Slack, Discord, Telegram, GitHub) failed; the message
names the call and the HTTP status or the platform's error.

**Fix:** check the bot token and its permissions, and the platform status. See [Channels](./channels.md).

**Example:** Slack `chat.postMessage` answering `channel_not_found`, Telegram `sendMessage` answering 400 for an unknown chat, or GitHub `POST /repos/{owner}/{repo}/issues/{number}/comments` answering 403 for a token without write access.

### LOUSHO_DEPLOY_FAILED

**Means:** `lousho build` / `lousho dev` / the node-server runtime could not
bundle or start the agent: a missing `--agent`, an agent path that is not found
or not an agent directory, a bad `LOUSHO_STORE` value, missing runtime sources, or a tool the
Cloudflare Worker target does not have.

**Fix:** follow the message. See [Deployment](./deployment.md).

**Example:** `lousho build --target node-server` without `--agent`.

## Tests and evals

### LOUSHO_EVALS_INVALID

**Means:** an eval helper was used wrongly: `defineEval()` outside vitest,
`t.judge()` before `t.send()` or without a judge, or `llmJudge()` outside the
judge runner.

**Fix:** follow the message. See [Evals](./evals.md).

**Example:** calling `t.judge('polite')` before `t.send('hi')`.

### LOUSHO_TEST_FAILED

**Means:** a check a test helper makes did not hold: an eval did not pass, or a
`mockModel()` script still had unused turns at the end.

**Fix:** read the message; fix the agent or remove the extra scripted turns. See [Testing](./testing.md).

**Example:** `mockModel([...three turns])` where the agent stopped after two.

### LOUSHO_CASSETTE_INVALID

**Means:** a record/replay cassette is missing, is not valid JSON or does not
match the recorded request. The message names the file.

**Fix:** record it again (`lousho eval --record <file>`, or `recordReplay()` with
`mode: 'record'`). See [Testing](./testing.md).

**Example:** `lousho eval --replay` for an eval that was never recorded.

## General

### LOUSHO_GENERIC_ERROR

**Means:** an `SDKError` created without a code.

**Fix:** read the message; it says what failed.

**Example:** `new SDKError('Something failed')`.

### LOUSHO_AGENT_EXECUTION_FAILED

**Means:** an `AgentExecutionError`: running an agent failed.

**Fix:** look at `error.cause` for the underlying failure.

**Example:** `new AgentExecutionError('Agent failed', agentId, cause)`.

### LOUSHO_FLOW_EXECUTION_FAILED

**Means:** a `FlowExecutionError`: a flow step failed.

**Fix:** look at `error.step` and `error.cause`. See [Flows](./flows.md).

**Example:** a flow step whose agent threw.

### LOUSHO_VALIDATION_FAILED

**Means:** a `ValidationError`: input failed validation.

**Fix:** fix the fields listed in `error.errors`.

**Example:** `new ValidationError('Validation failed', { email: ['Invalid email'] })`.

### LOUSHO_OPERATION_TIMEOUT

**Means:** a `TimeoutError`: an operation (`error.operation`) did not finish
within `error.timeoutMs`.

**Fix:** raise the timeout, or make the operation faster.

**Example:** `retryWithTimeout()` whose operation takes longer than its timeout.

### LOUSHO_OUTPUT_INVALID

**Means:** reserved. An invalid structured-output reply is not thrown today: the
run ends with `finishReason: 'output-invalid'` and `outputError`.

**Fix:** see [Structured output](./structured-output.md).

**Example:** a reply that does not match `output: zodSchema` after the repair step.

### LOUSHO_BUDGET_EXCEEDED

**Means:** a run's or a session's `limits` budget (`maxTokens`, `maxCostUsd`,
`maxDurationMs`, ...) tripped under `onExceeded: 'throw'`. `BudgetExceededError`
carries `budget: { limit, value, max, scope }`. With the default
`onExceeded: 'stop'` nothing is thrown: the run ends with
`finishReason: 'budget-exceeded'`.

**Fix:** raise the limit named in the message, or drop `onExceeded: 'throw'`.
See [Budgets](./configuration.md#budgets).

**Example:** `createAgent({ provider, limits: { maxCostUsd: 0.01, onExceeded: 'throw' } })` whose run costs more than a cent.

### LOUSHO_GUARDRAIL_TRIPPED

**Means:** an input, output or tool guardrail blocked a run under
`onTripped: 'throw'`. `GuardrailError` carries
`guardrail: { name, kind, reason, toolName? }`. With the default
`onTripped: 'stop'` nothing is thrown: the run ends with
`finishReason: 'guardrail'`.

**Fix:** look at `error.guardrail` for which guardrail blocked and why, or drop
`onTripped: 'throw'`. See [Input and output guardrails](./guardrails.md#input-and-output-guardrails).

**Example:** `createAgent({ provider, guardrails: { input: [maxLengthGuardrail({ maxChars: 10 })], onTripped: 'throw' } })` sent a longer message.

## Auth

### LOUSHO_AUTH_CONFIG_INVALID

**Means:** a route auth helper from `@lousho/build-ai-agent/auth` (`jwt()`,
`oidc()`, `basic()`, `apiToken()`) got options it cannot verify with, and
refused them when it was created, not at the first request. The message names
the option: no key source or two of them, an HMAC `secret` shorter than 32
bytes, an algorithm that does not fit the key (`secret` with `RS256`, a public
key with `HS256`), no `audience` (and no `allowAnyAudience: true`), a
`clockToleranceSec` above 300, a key-set or issuer URL that is not https, an
empty user list or token.

**Fix:** change the option the message names. See [Route auth and principals](./auth.md).

**Example:** `jwt({ secret: process.env.JWT_SECRET! })` without `audience`.

## OAuth

### LOUSHO_TOKEN_KEY_MISSING

**Means:** a file, SQLite or KV store was asked to store an OAuth token, a
pending sign-in or a registered client (or to read one that exists), and it has
no token key: neither its `tokenKey` option nor the `LOUSHO_TOKEN_KEY`
environment variable is set. Tokens are only ever stored encrypted, and there
is no default key. Reads of records that do not exist need no key.

**Fix:** generate a key once with `generateTokenKey()` (32 random bytes as
base64), keep it as a secret, and pass it as `tokenKey` or set
`LOUSHO_TOKEN_KEY`. On Cloudflare Workers, add it with
`wrangler secret put LOUSHO_TOKEN_KEY`. See [Token storage](./oauth.md#token-storage).

**Example:** `new SqliteStore('./agent.db').tokens.set('github', { owner: 'app' }, token)`
with `LOUSHO_TOKEN_KEY` unset.

### LOUSHO_TOKEN_DECRYPT_FAILED

**Means:** a stored OAuth record could not be decrypted: the store's key is not
the one it was written with, or the record was changed or copied to another
owner. The message names the provider, never the token.

**Fix:** use the key the tokens were written with. While rotating, list the old
key after the new one (`tokenKey: [newKey, oldKey]`, or
`LOUSHO_TOKEN_KEY="<new>,<old>"`). If the old key is lost, delete the record
(`tokens.delete(provider, owner)`) and sign in again. See
[Token storage](./oauth.md#token-storage).

**Example:** a `SqliteStore` file written with one `tokenKey` and opened with
another.
