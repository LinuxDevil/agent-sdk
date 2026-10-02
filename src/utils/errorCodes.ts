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
  LOUSHO_GENERIC_ERROR: 'Read the message above; it names what failed.',
  LOUSHO_CONFIG_INVALID: 'Fix the option named in the message.',
  LOUSHO_CONFIG_MISSING_PROVIDER:
    "Pass a model string such as createAgent({ model: 'openai/gpt-4o-mini' }), a provider instance, or set LOUSHO_MODEL or a provider API key.",
  LOUSHO_CONFIG_MISSING_AGENT: 'Pass the agent to run, e.g. AgentBuilder.create().setName(...).build().',
  LOUSHO_CONFIG_MISSING_INPUT: 'Pass the user message (a string or a Message[]) as `input`.',
  LOUSHO_CONFIG_CONFLICTING_OPTIONS: 'Keep one of the two options named in the message and remove the other.',
  LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE:
    'Pass createAgent({ store }) with `checkpoints` (e.g. memoryStore() or a SqliteStore), or drop `sessionId`.',
  LOUSHO_CONFIG_RESOLVER_FAILED: "Fix the createAgent() option function named in the message; its own error is the `cause`.",
  LOUSHO_PROVIDER_SPEC_INVALID: "Write the model as '<provider>/<model>', e.g. 'openai/gpt-4o-mini'.",
  LOUSHO_PROVIDER_UNKNOWN: 'Use one of the supported provider prefixes listed in the message.',
  LOUSHO_PROVIDER_MISSING_API_KEY: 'Set the environment variable named in the message, or pass a provider instance.',
  LOUSHO_PROVIDER_REQUEST_FAILED: 'Check the provider status, your API key and the request; retryable failures are retried by withRetry().',
  LOUSHO_PROVIDER_RATE_LIMITED: 'Wait and retry (withRetry() honours Retry-After), or lower the request rate.',
  LOUSHO_PEER_MISSING: 'Run the npm install command shown in the message.',
  LOUSHO_SPEC_INVALID: 'Fix the spec fields named in the message (each is shown as its path and the problem).',
  LOUSHO_SPEC_UNKNOWN_FIELD: 'Rename the field to the suggested spec field, or remove it.',
  LOUSHO_SPEC_UNSUPPORTED_FORMAT: 'Save the spec as .yaml, .yml or .json.',
  LOUSHO_SCHEDULE_INVALID: 'Fix the cron expression named in the message, and give the schedule exactly one of `prompt` or `run`.',
  LOUSHO_CHANNEL_INVALID: 'Default-export a channel from defineChannel(), httpChannel(), webhookChannel() or slackChannel() in each channels/ file.',
  LOUSHO_MEMORY_INVALID: 'Default-export a memory slot from defineMemory() (or an object with a scope and a provider) in each memory/ file.',
  LOUSHO_REGISTRY_UNREACHABLE: 'Check the --registry url or path (http(s) or a local file) and that you are online; the message names what failed.',
  LOUSHO_REGISTRY_ITEM_NOT_FOUND: 'Run `lousho add --list` for the names in the registry, and use one of them.',
  LOUSHO_REGISTRY_INVALID: 'Fix the registry document the message names; docs/registry.md shows the format.',
  LOUSHO_REGISTRY_UNSAFE_PATH: 'Do not install this item; it asks to write outside its allowed folder or is too large, so tell the registry owner.',
  LOUSHO_REGISTRY_FILE_EXISTS: 'Pass --overwrite to replace the existing file, or move your file away first.',
  LOUSHO_REGISTRY_MANIFEST_MISMATCH: 'Do not install this item: its code reaches for something its permission manifest does not declare; tell the registry owner, who fixes the code or the manifest.',
  LOUSHO_TOOL_NOT_FOUND: 'Use one of the tool names listed in the message, or register the tool yourself.',
  LOUSHO_TOOL_NEEDS_CREDENTIALS: 'Build the agent with createAgent() and pass the configured tool.',
  LOUSHO_TOOL_EXECUTION_FAILED: "Look at the tool's own error (the `cause`) and fix the tool or its input.",
  LOUSHO_TOOL_ARGS_INVALID: "Fix the arguments listed in the message (each is shown as its path and the problem); inside a run the model gets them as a tool result and can retry.",
  LOUSHO_AGENT_DIR_INVALID: 'Fix the file or folder the message names; docs/agent-directories.md shows the layout.',
  LOUSHO_SKILL_INVALID: 'Fix the skill the message names (a name, a description and content), or the skills option it was passed to.',
  LOUSHO_FLOW_INVALID: 'Fix the flow definition the message names (its name, code, inputs and node types).',
  LOUSHO_STORAGE_FAILED: 'Read the message: it names the database or file that failed; check the path, permissions and Node version, and the `cause`.',
  LOUSHO_TRIGGER_INVALID: 'Fix the trigger option the message names; the message shows a working example.',
  LOUSHO_DEPLOY_FAILED: 'Read the message: it names the missing option, file or unsupported feature; docs/deployment.md covers each target.',
  LOUSHO_EVALS_INVALID: 'Call the eval helper the way the message says (inside a vitest file, after t.send(), with a judge configured).',
  LOUSHO_TEST_FAILED: 'Read the message: an eval or a mockModel() script did not hold; fix the agent, or the expectation.',
  LOUSHO_CASSETTE_INVALID: 'Record the cassette again (lousho eval --record, or recordReplay mode: record), or fix the file the message names.',
  LOUSHO_CHANNEL_REQUEST_FAILED: "Check the platform's token and permissions and its status page; the message names the call and its status.",
  LOUSHO_APPROVAL_STORE_MISSING: 'Pass an approvalStore (e.g. new InMemoryApprovalStore()), or use createAgent(), which has one.',
  LOUSHO_APPROVAL_NOT_FOUND: 'Resolve an id that is still pending (agent.approvals.list() lists them); each approval resolves once.',
  LOUSHO_SESSION_AWAITING_APPROVAL: 'Resolve the pending approval first (agent.approvals.resolve() or resumeAfterApproval()), then send again.',
  LOUSHO_SESSION_ID_INVALID: "Use 1-128 characters from A-Z, a-z, 0-9, '_' and '-', or omit the id.",
  LOUSHO_SESSION_BUSY: 'Wait for the running turn to finish (await its send(), or abort it), then call again.',
  LOUSHO_SESSION_TURN_PENDING: 'Finish the interrupted turn with session.resume(), or drop it with session.discardPending(), then call again.',
  LOUSHO_SESSION_FILE_CORRUPT: 'Restore or delete the session file named in the message.',
  LOUSHO_SESSION_STREAM_UNSUPPORTED: 'Create the session with agent.session(), which can stream, or call send() instead.',
  LOUSHO_REMOTE_UNAUTHORIZED: "Pass the deployment's bearer token (its LOUSHO_API_TOKEN): `auth` of remoteAgent()/remoteTarget(), or --token / LOUSHO_EVAL_TOKEN for `lousho eval`.",
  LOUSHO_REMOTE_REQUEST_FAILED: "Read the message: it names the remote agent's url and what failed. Check the url, that the deployment is up (GET /health), and its logs.",
  LOUSHO_SUBAGENT_TASK_NOT_FOUND:
    "Pass a taskId from an earlier task result of this lead session, with the same agent, or omit taskId to start a new task.",
  LOUSHO_SUBAGENT_TASK_BUSY: 'Wait for the task with agent_await (or stop it with agent_cancel), then continue it.',
  LOUSHO_CHECKPOINT_NOT_FOUND:
    "Fork at a step the session's checkpoint history still keeps (checkpointStore.history() lists them), or raise the store's historyLimit.",
  LOUSHO_AGENT_DRIFT: "Resume with the agent that paused the run (same model, tools and instructions), or set onAgentDrift: 'warn' or 'ignore' to continue anyway.",
  LOUSHO_RESUME_TOOL_MISSING: 'Bring the tool named in the message back (same name), or drop the paused run: delete its checkpoint and reject its approval.',
  LOUSHO_RUN_ALREADY_ITERATED: 'Iterate an AgentRun once; call stream() again for a new run.',
  LOUSHO_SANDBOX_EGRESS_UNSUPPORTED:
    "Run on Docker Engine 25.0.5+ for Linux on this host (not Docker Desktop, rootless or a remote daemon), or use network: 'none'.",
  LOUSHO_AGENT_EXECUTION_FAILED: 'Look at the `cause` for the underlying failure.',
  LOUSHO_FLOW_EXECUTION_FAILED: 'Look at the failing `step` and the `cause`.',
  LOUSHO_VALIDATION_FAILED: 'Fix the fields listed in `errors`.',
  LOUSHO_OPERATION_TIMEOUT: 'Raise the timeout or make the operation faster.',
  LOUSHO_OUTPUT_INVALID: "Reserved: an invalid structured reply is reported as finishReason 'output-invalid', not thrown.",
  LOUSHO_BUDGET_EXCEEDED:
    "Raise the limit named in the message, or use onExceeded: 'stop' (the default) to get finishReason 'budget-exceeded' instead of an error.",
  LOUSHO_GUARDRAIL_TRIPPED:
    "Look at `error.guardrail` for which guardrail blocked and why, or use onTripped: 'stop' (the default) to get finishReason 'guardrail' instead of an error.",
  LOUSHO_TOKEN_KEY_MISSING:
    "Pass the store's tokenKey (32 random bytes as base64, from generateTokenKey()) or set LOUSHO_TOKEN_KEY before storing OAuth tokens.",
  LOUSHO_TOKEN_DECRYPT_FAILED:
    'Use the tokenKey the tokens were written with (list the old key after the new one while rotating), or delete the record and sign in again.',
} as const;

/** A stable error code, e.g. `'LOUSHO_CONFIG_MISSING_PROVIDER'`. */
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
