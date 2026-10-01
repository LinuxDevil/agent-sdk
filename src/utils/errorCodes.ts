/**
 * The registry of stable SDK error codes (LOU-D2).
 *
 * Every `SDKError` carries one of these as `code`, with the matching one-
 * sentence `hint` and a `docs` link to its section of docs/errors.md. A test
 * keeps this table, the codes used in src/ and docs/errors.md in sync.
 */

/** Where every code is documented; each code has the anchor `#<code in lowercase>`. */
export const ERROR_DOCS_URL = 'https://github.com/LinuxDevil/agent-sdk/blob/main/docs/errors.md';

/** Every stable error code, mapped to its one-sentence "how to fix" hint. */
export const ERROR_CODES = {
  LOUSHY_GENERIC_ERROR: 'Read the message above; it names what failed.',
  LOUSHY_CONFIG_INVALID: 'Fix the option named in the message.',
  LOUSHY_CONFIG_MISSING_PROVIDER:
    "Pass a model string such as createAgent({ model: 'openai/gpt-4o-mini' }), a provider instance, or set LOUSHY_MODEL or a provider API key.",
  LOUSHY_CONFIG_MISSING_AGENT: 'Pass the agent to run, e.g. AgentBuilder.create().setName(...).build().',
  LOUSHY_CONFIG_MISSING_INPUT: 'Pass the user message (a string or a Message[]) as `input`.',
  LOUSHY_CONFIG_CONFLICTING_OPTIONS: 'Keep one of the two options named in the message and remove the other.',
  LOUSHY_CONFIG_MISSING_CHECKPOINT_STORE:
    'Pass createAgent({ store }) with `checkpoints` (e.g. memoryStore() or a SqliteStore), or drop `sessionId`.',
  LOUSHY_CONFIG_RESOLVER_FAILED: "Fix the createAgent() option function named in the message; its own error is the `cause`.",
  LOUSHY_PROVIDER_SPEC_INVALID: "Write the model as '<provider>/<model>', e.g. 'openai/gpt-4o-mini'.",
  LOUSHY_PROVIDER_UNKNOWN: 'Use one of the supported provider prefixes listed in the message.',
  LOUSHY_PROVIDER_MISSING_API_KEY: 'Set the environment variable named in the message, or pass a provider instance.',
  LOUSHY_PROVIDER_REQUEST_FAILED: 'Check the provider status, your API key and the request; retryable failures are retried by withRetry().',
  LOUSHY_PROVIDER_RATE_LIMITED: 'Wait and retry (withRetry() honours Retry-After), or lower the request rate.',
  LOUSHY_PEER_MISSING: 'Run the npm install command shown in the message.',
  LOUSHY_SPEC_INVALID: 'Fix the spec fields named in the message (each is shown as its path and the problem).',
  LOUSHY_SPEC_UNKNOWN_FIELD: 'Rename the field to the suggested spec field, or remove it.',
  LOUSHY_SPEC_UNSUPPORTED_FORMAT: 'Save the spec as .yaml, .yml or .json.',
  LOUSHY_SCHEDULE_INVALID: 'Fix the cron expression named in the message, and give the schedule exactly one of `prompt` or `run`.',
  LOUSHY_CHANNEL_INVALID: 'Default-export a channel from defineChannel(), httpChannel(), webhookChannel() or slackChannel() in each channels/ file.',
  LOUSHY_MEMORY_INVALID: 'Default-export a memory slot from defineMemory() (or an object with a scope and a provider) in each memory/ file.',
  LOUSHY_TOOL_NOT_FOUND: 'Use one of the tool names listed in the message, or register the tool yourself.',
  LOUSHY_TOOL_NEEDS_CREDENTIALS: 'Build the agent with createAgent() and pass the configured tool.',
  LOUSHY_TOOL_EXECUTION_FAILED: "Look at the tool's own error (the `cause`) and fix the tool or its input.",
  LOUSHY_REMOTE_AGENT_FAILED: "Read the message: it names the remote agent's url and what failed (network, 401, HTTP status, or the remote run's error).",
  LOUSHY_APPROVAL_STORE_MISSING: 'Pass an approvalStore (e.g. new InMemoryApprovalStore()), or use createAgent(), which has one.',
  LOUSHY_APPROVAL_NOT_FOUND: 'Resolve an id that is still pending (agent.approvals.list() lists them); each approval resolves once.',
  LOUSHY_SESSION_AWAITING_APPROVAL: 'Resolve the pending approval first (agent.approvals.resolve() or resumeAfterApproval()), then send again.',
  LOUSHY_SESSION_ID_INVALID: "Use 1-128 characters from A-Z, a-z, 0-9, '_' and '-', or omit the id.",
  LOUSHY_SESSION_FILE_CORRUPT: 'Restore or delete the session file named in the message.',
  LOUSHY_SESSION_STREAM_UNSUPPORTED: 'Create the session with agent.session(), which can stream, or call send() instead.',
  LOUSHY_REMOTE_UNAUTHORIZED: "Pass the deployment's bearer token with --token or LOUSHY_EVAL_TOKEN (its LOUSHY_API_TOKEN).",
  LOUSHY_REMOTE_REQUEST_FAILED: 'Check the --url, that the deployment is up (GET /health), and its logs.',
  LOUSHY_CHECKPOINT_NOT_FOUND:
    "Fork at a step the session's checkpoint history still keeps (checkpointStore.history() lists them), or raise the store's historyLimit.",
  LOUSHY_RUN_ALREADY_ITERATED: 'Iterate an AgentRun once; call stream() again for a new run.',
  LOUSHY_AGENT_EXECUTION_FAILED: 'Look at the `cause` for the underlying failure.',
  LOUSHY_FLOW_EXECUTION_FAILED: 'Look at the failing `step` and the `cause`.',
  LOUSHY_VALIDATION_FAILED: 'Fix the fields listed in `errors`.',
  LOUSHY_OPERATION_TIMEOUT: 'Raise the timeout or make the operation faster.',
  LOUSHY_OUTPUT_INVALID: "Reserved: an invalid structured reply is reported as finishReason 'output-invalid', not thrown.",
  LOUSHY_BUDGET_EXCEEDED:
    "Raise the limit named in the message, or use onExceeded: 'stop' (the default) to get finishReason 'budget-exceeded' instead of an error.",
  LOUSHY_GUARDRAIL_TRIPPED:
    "Look at `error.guardrail` for which guardrail blocked and why, or use onTripped: 'stop' (the default) to get finishReason 'guardrail' instead of an error.",
} as const;

/** A stable error code, e.g. `'LOUSHY_CONFIG_MISSING_PROVIDER'`. */
export type ErrorCode = keyof typeof ERROR_CODES;

/** The docs link of `code`: `docs/errors.md#<code in lowercase>`. */
export function errorDocsUrl(code: string): string {
  return `${ERROR_DOCS_URL}#${code.toLowerCase()}`;
}

/** The registered hint and docs link of `code`; `undefined` for a code outside the registry. */
export function errorHelp(code: string): { hint: string; docs: string } | undefined {
  if (!Object.hasOwn(ERROR_CODES, code)) return undefined;
  return { hint: ERROR_CODES[code as ErrorCode], docs: errorDocsUrl(code) };
}
