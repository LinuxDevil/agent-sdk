/**
 * The registry of stable SDK error codes.
 *
 * Every `SDKError` carries one of these as `code`, with the matching one-
 * sentence `hint` and a `docs` link to its section of docs/errors.md. A test
 * keeps this table, the codes used in src/ and docs/errors.md in sync.
 */

/** Where every code is documented; the site serves docs/errors.md as /errors; each code has the anchor `#<code in lowercase>`. */
export const ERROR_DOCS_URL = 'https://lousho.com/errors';

/** Every stable error code, mapped to its one-sentence "how to fix" hint. */
export const ERROR_CODES = {
  LOUSHO_GENERIC_ERROR: 'Read the message above; it names what failed.',
  LOUSHO_CONFIG_INVALID: 'Fix the option named in the message.',
  LOUSHO_CONFIG_MISSING_PROVIDER:
    "Pass a model string such as createAgent({ model: 'openai/gpt-4.1-mini' }), a provider instance, or set LOUSHO_MODEL or a provider API key.",
  LOUSHO_CONFIG_MISSING_AGENT: 'Pass the agent to run, e.g. AgentBuilder.create().setName(...).build().',
  LOUSHO_CONFIG_MISSING_INPUT: 'Pass the user message (a string or a Message[]) as `input`.',
  LOUSHO_CONFIG_CONFLICTING_OPTIONS: 'Keep one of the two options named in the message and remove the other.',
  LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE:
    'Pass createAgent({ store }) with `checkpoints` (e.g. memoryStore() or a SqliteStore), or drop `sessionId`.',
  LOUSHO_CONFIG_RESOLVER_FAILED: "Fix the createAgent() option function named in the message; its own error is the `cause`.",
  LOUSHO_PROVIDER_SPEC_INVALID: "Write the model as '<provider>/<model>', e.g. 'openai/gpt-4.1-mini'.",
  LOUSHO_PROVIDER_UNKNOWN:
    'Use one of the supported provider prefixes listed in the message; reach any other vendor through openrouter/<vendor>/<model>, pi/<vendor>/<model> or fromAiSdk().',
  LOUSHO_PROVIDER_MISSING_API_KEY: 'Set the environment variable named in the message, or pass a provider instance.',
  LOUSHO_PROVIDER_REQUEST_FAILED: 'Check the provider status, your API key and the request; retryable failures are retried by withRetry().',
  LOUSHO_PROVIDER_RATE_LIMITED: 'Wait and retry (withRetry() honours Retry-After), or lower the request rate.',
  LOUSHO_PEER_MISSING: 'Run the npm install command shown in the message.',
  LOUSHO_HOSTED_TOOL_UNSUPPORTED:
    'Use a provider and package pairing that runs this hosted tool (see docs/hosted-tools.md), or leave the tool out of `tools`.',
  LOUSHO_UNSUPPORTED_CONTENT:
    "Send this content to a provider that takes it (see docs/providers.md#multimodal-input), put the file's text in the message, or set the provider's `unsupportedFiles: 'text-note'`.",
  LOUSHO_SPEC_NOT_FOUND: 'Check the spec file path in the message; no file exists there.',
  LOUSHO_SPEC_INVALID: 'Fix the spec fields named in the message (each is shown as its path and the problem).',
  LOUSHO_SPEC_UNKNOWN_FIELD: 'Rename the field to the suggested spec field, or remove it.',
  LOUSHO_SPEC_UNSUPPORTED_FORMAT: 'Save the spec as .yaml, .yml or .json.',
  /** An AgentSpec v2 sets a field this version of the SDK cannot run yet. */
  LOUSHO_SPEC_UNSUPPORTED: 'Remove the field the message names, or upgrade lousho to a version that can run it.',
  /** An AgentSpec v2 secret ref (`{ env }` / `{ secret }`) has no value where the agent is being built. */
  LOUSHO_SPEC_SECRET_MISSING: 'Set the environment variable or add the named secret the message gives, then run the agent again.',
  LOUSHO_SCHEDULE_INVALID: 'Fix the cron expression named in the message, and give the schedule exactly one of `prompt` or `run`.',
  LOUSHO_SCHEDULE_RUN_INCOMPLETE: 'Resolve the pending approval named in the message, or change the prompt, tools or limits so an unattended turn can finish.',
  LOUSHO_CHANNEL_INVALID: 'Default-export a channel from defineChannel(), httpChannel(), webhookChannel() or slackChannel() in each channels/ file.',
  LOUSHO_MEMORY_INVALID: 'Default-export a memory slot from defineMemory() (or an object with a scope and a provider) in each memory/ file.',
  LOUSHO_REGISTRY_UNREACHABLE: 'Check the --registry url or path (http(s) or a local file) and that you are online; the message names what failed.',
  LOUSHO_REGISTRY_ITEM_NOT_FOUND: 'Run `lousho add --list` for the names in the registry, and use one of them.',
  LOUSHO_REGISTRY_INVALID: 'Fix the registry document the message names; docs/registry.md shows the format.',
  LOUSHO_REGISTRY_UNSAFE_PATH: 'Do not install this item; it asks to write outside its allowed folder or is too large, so tell the registry owner.',
  LOUSHO_REGISTRY_FILE_EXISTS: 'Pass --overwrite to replace the existing file, or move your file away first.',
  LOUSHO_REGISTRY_MANIFEST_MISMATCH: 'Do not install this item: its code reaches for something its permission manifest does not declare; tell the registry owner, who fixes the code or the manifest.',
  /** A registry `prompt` ref with no `instructions` fallback could not be fetched, so the run is refused. */
  LOUSHO_PROMPT_UNRESOLVED: 'Start the observe daemon (set LOUSHO_OBSERVE to its URL), or pass `instructions` as a fallback.',
  LOUSHO_TOOL_NOT_FOUND: 'Use one of the tool names listed in the message, or register the tool yourself.',
  LOUSHO_TOOL_NEEDS_CREDENTIALS: 'Build the agent with createAgent() and pass the configured tool.',
  LOUSHO_TOOL_EXECUTION_FAILED: "Look at the tool's own error (the `cause`) and fix the tool or its input.",
  LOUSHO_TOOL_ARGS_INVALID: "Fix the arguments listed in the message (each is shown as its path and the problem); inside a run the model gets them as a tool result and can retry.",
  LOUSHO_AGENT_DIR_INVALID: 'Fix the file or folder the message names; docs/agent-directories.md shows the layout.',
  LOUSHO_SKILL_INVALID: 'Fix the skill the message names (a name, a description and content), or the skills option it was passed to.',
  LOUSHO_FLOW_INVALID: 'Fix the flow definition the message names (its name, code, inputs and node types).',
  LOUSHO_FLOW_TOOL_DENIED:
    "Pass an approve callback in the flow context to decide tool calls that need approval, or change the permission rule or needsApproval policy that denied the call.",
  /** `FlowExecutor.resume()` with a flow whose steps changed since the run was saved. */
  LOUSHO_FLOW_CHANGED: 'Resume the run with the flow version that started it (same steps in the same order), or start a new run with another runId.',
  LOUSHO_STORAGE_FAILED: 'Read the message: it names the database or file that failed; check the path, permissions and Node version, and the `cause`.',
  LOUSHO_STORAGE_BUSY: 'Another process holds the SQLite write lock; retry the call, or find what keeps the lock (a long transaction, a backup, a second replica).',
  /** A run asked an artifact store for an artifact of another run or workspace. */
  LOUSHO_ARTIFACT_FORBIDDEN: "Read only the run's own artifacts, or pass the artifact's uri to this run as a ref (through the main agent).",
  /** An artifact was larger than the store's `maxArtifactBytes`. */
  LOUSHO_ARTIFACT_TOO_LARGE: 'Write a smaller artifact, or raise maxArtifactBytes on the artifact store.',
  /** An artifact name was stored again with other content or another media type. */
  LOUSHO_ARTIFACT_EXISTS: 'Store the new content under a new artifact name; a stored artifact never changes.',
  /** The file artifact store found a symlink or a non-plain entry where it reads or writes. */
  LOUSHO_ARTIFACT_UNSAFE_PATH: 'Remove the symlink or other entry the message names from the artifact store folder; the store reads and writes only plain folders and files inside its root.',
  LOUSHO_TRIGGER_INVALID: 'Fix the trigger option the message names; the message shows a working example.',
  LOUSHO_DEPLOY_FAILED: 'Read the message: it names the missing option, file or unsupported feature; docs/deployment.md covers each target.',
  /** The built server was asked to listen on a non-loopback host with no route auth. */
  LOUSHO_SERVER_UNPROTECTED:
    'Set LOUSHO_API_TOKEN, add an auth.ts to the agent directory, bind to 127.0.0.1, or set LOUSHO_ALLOW_PUBLIC=1 to serve an open agent on purpose.',
  /** A `defineEval({ dataset })` dataset could not be fetched from the observe daemon, or is empty. */
  LOUSHO_DATASET_UNAVAILABLE: 'Start the observe daemon and set LOUSHO_OBSERVE to its URL, and create the dataset the message names with examples in it.',
  LOUSHO_EVALS_INVALID: 'Call the eval helper the way the message says (inside a vitest file, after t.send(), with a judge configured).',
  LOUSHO_TEST_FAILED: 'Read the message: an eval or a mockModel() script did not hold; fix the agent, or the expectation.',
  LOUSHO_CASSETTE_INVALID: 'Record the cassette again (lousho eval --record, or recordReplay mode: record), or fix the file the message names.',
  LOUSHO_CHANNEL_REQUEST_FAILED: "Check the platform's token and permissions and its status page; the message names the call and its status.",
  LOUSHO_APPROVAL_STORE_MISSING: 'Pass an approvalStore (e.g. new InMemoryApprovalStore()), or use createAgent(), which has one.',
  LOUSHO_APPROVAL_NOT_FOUND: 'Resolve an id that is still pending (agent.approvals.list() lists them); each approval resolves once.',
  LOUSHO_APPROVAL_ORPHANED: "The paused run (or session turn) was deleted or replaced by a newer one; the approval is withdrawn and cannot be continued - start a new turn instead.",
  LOUSHO_APPROVAL_CONFLICT:'Another request decided this approval at the same time; read the session to see the outcome instead of deciding again.',
  LOUSHO_APPROVAL_FORBIDDEN: 'Decide the approval as a caller the route\'s authorizeApproval accepts (by default, the caller the run acts for).',
  /** The approvals route got a body without `approved` or `answer` (`400`). */
  LOUSHO_APPROVAL_DECISION_INVALID: "Send a JSON body with 'approved' (true or false, and an optional 'note') or, for a question, 'answer'.",
  LOUSHO_APPROVAL_KIND_MISMATCH: "'answer' decides a question pause only; a tool-call pause takes 'approved' (a question also answers with 'approved' and the answer as 'note').",
  /** `modelAutoApprover`'s reply carried no usable `{ safety, reason }` verdict. */
  LOUSHO_AUTO_APPROVAL_INVALID:
    'Check the auto approver\'s model and prompt: its reply must be a JSON object { "safety": <0..1>, "reason": "<text>" } (prose around it is fine).',
  LOUSHO_SESSION_FORBIDDEN: 'Use a session the route\'s authorizeSession lets this caller read, continue or decide approvals in.',
  /** A session route refused a cross-site POST or a `Host` outside `allowedHosts` (`403`). */
  LOUSHO_REQUEST_FORBIDDEN: "Call from the server's own origin (or add the page's origin to allowedOrigins) and use a Host the server allows (allowedHosts).",
  /** A session route got a body it cannot use: invalid JSON, or missing or empty fields (`400`). */
  LOUSHO_REQUEST_INVALID: 'Send valid JSON with the fields the route names, e.g. POST /chat { "sessionId": "chat-1", "input": "Hello" }.',
  /** A session route refused a POST body that is not JSON (`415`). */
  LOUSHO_UNSUPPORTED_MEDIA_TYPE: "Send the request body as JSON with the header 'Content-Type: application/json'.",
  LOUSHO_SESSION_AWAITING_APPROVAL: 'Resolve the pending approval first (agent.approvals.resolve() or resumeAfterApproval()), then send again.',
  LOUSHO_SESSION_ID_INVALID: "Session ids (agent.session({ id }), POST /chat): 1-128 characters from A-Z, a-z, 0-9, '_' and '-'. Run ids (send({ sessionId })): up to 200 and '.' too, not ending in '.turn-<n>', '.paused' or '.fire'.",
  LOUSHO_SESSION_BUSY: 'Wait for the running turn to finish (await its send(), or abort it), then call again.',
  LOUSHO_SESSION_TURN_PENDING: 'Finish the interrupted turn with session.resume(), or drop it with session.discardPending(), then call again.',
  LOUSHO_SESSION_TURN_FAILED: "Drop the failed turn with session.discardPending() and send again, or fix the cause and retry it with session.resume().",
  LOUSHO_SESSION_FILE_CORRUPT: 'Restore or delete the session transcript named in the message (session.clear() removes it).',
  LOUSHO_SESSION_STREAM_UNSUPPORTED: 'Create the session with agent.session(), which can stream, or call send() instead.',
  LOUSHO_SESSION_STEP_NOT_FOUND: 'Pass a fromStep in the range the message lists (see session.history()); 0 keeps nothing.',
  LOUSHO_SESSION_EXISTS: 'Pick a session id that has no transcript in the store yet, or leave `id` out for <id>-fork-<n>.',
  LOUSHO_SESSION_FORK_UNSUPPORTED: 'Create the session with agent.session(), which can fork.',
  LOUSHO_REMOTE_UNAUTHORIZED: "Pass the deployment's bearer token (its LOUSHO_API_TOKEN): `auth` of remoteAgent()/remoteTarget(), or --token / LOUSHO_EVAL_TOKEN for `lousho eval`.",
  LOUSHO_REMOTE_REQUEST_FAILED: "Read the message: it names the remote agent's url and what failed. Check the url, that the deployment is up (GET /health), and its logs.",
  LOUSHO_SUBAGENT_TASK_NOT_FOUND:
    "Pass a taskId from an earlier task result of this lead session, with the same agent, or omit taskId to start a new task.",
  LOUSHO_SUBAGENT_TASK_BUSY: 'Wait for the task with agent_await (or stop it with agent_cancel), then continue it.',
  LOUSHO_CHECKPOINT_NOT_FOUND:
    "Fork at a step the session's checkpoint history still keeps (checkpointStore.history() lists them), or raise the store's historyLimit.",
  /** A stored checkpoint cannot be read (not JSON, or not a checkpoint). */
  LOUSHO_CHECKPOINT_CORRUPT: 'Drop the unreadable checkpoint with session.discardPending() or session.clear() (or checkpointStore.delete(id)); the interrupted run cannot be resumed.',
  LOUSHO_AGENT_DRIFT: "Resume with the agent that paused the run (same model, tools and instructions), or set onAgentDrift: 'warn' or 'ignore' to continue anyway.",
  LOUSHO_RESUME_TOOL_MISSING: 'Bring the tool named in the message back (same name), or drop the paused run: delete its checkpoint and reject its approval.',
  LOUSHO_RUN_ALREADY_ITERATED: 'Iterate an AgentRun once; call stream() again for a new run.',
  LOUSHO_SANDBOX_PATH_DENIED: "Write under the sandbox's root (SubprocessSandbox({ root })), or pass the root that should contain the path.",
  LOUSHO_SANDBOX_EGRESS_UNSUPPORTED:
    "Run on Docker Engine 25.0.5+ for Linux on this host (not Docker Desktop, rootless or a remote daemon), or use network: 'none'.",
  LOUSHO_SANDBOX_FAILED:
    "The error's `kind` says which boundary failed ('timeout', 'oom' or 'driver'); raise the limit in sandbox()/defineTool({ sandbox }), or check the driver.",
  LOUSHO_AGENT_EXECUTION_FAILED: 'Look at the `cause` for the underlying failure.',
  LOUSHO_FLOW_EXECUTION_FAILED: 'Look at the failing `step` and the `cause`.',
  LOUSHO_VALIDATION_FAILED: 'Fix the fields listed in `errors`.',
  LOUSHO_OPERATION_TIMEOUT: 'Raise the timeout or make the operation faster.',
  LOUSHO_OUTPUT_INVALID: "Reserved: an invalid structured reply is reported as finishReason 'output-invalid', not thrown.",
  LOUSHO_BUDGET_EXCEEDED:
    "Raise the limit named in the message, or use onExceeded: 'stop' (the default) to get finishReason 'budget-exceeded' instead of an error.",
  /** `createProgressGuard()` stopped a run whose calls it kept denying. */
  LOUSHO_RUN_NO_PROGRESS: 'Read the heal.action events to see which calls were denied, then fix the agent or its tool before resuming.',
  LOUSHO_AUTH_CONFIG_INVALID: 'Fix the auth helper option named in the message (docs/auth.md lists what each helper needs).',
  LOUSHO_GUARDRAIL_TRIPPED:
    "Look at `error.guardrail` for which guardrail blocked and why, or use onTripped: 'stop' (the default) to get finishReason 'guardrail' instead of an error.",
  LOUSHO_TOKEN_KEY_MISSING:
    "Pass the store's tokenKey (32 random bytes as base64, from generateTokenKey()) or set LOUSHO_TOKEN_KEY before storing OAuth tokens.",
  LOUSHO_TOKEN_DECRYPT_FAILED:
    'Use the tokenKey the tokens were written with (list the old key after the new one while rotating), or delete the record and sign in again.',
  LOUSHO_OAUTH_PRINCIPAL_REQUIRED:
    "Run the agent behind route auth or a channel (so the run has a principal), or use credentialOwner: 'app' for a credential shared by everyone.",
  LOUSHO_OAUTH_APP_SIGNIN_REQUIRED: 'Sign the app in once: open the URL from agent.oauth.signInUrl(provider) and let the callback store the token.',
  LOUSHO_OAUTH_STORE_MISSING: 'Give the agent a store with `tokens`: createAgent({ store: memoryStore() }), fileStore(), SqliteStore or KVStore.',
  LOUSHO_OAUTH_STATE_INVALID: 'Start the sign-in again from a fresh link: a state works once, for 10 minutes, and only for the user it was made for.',
  LOUSHO_SIGNIN_PENDING: 'Open the sign-in link first and let the provider redirect to the callback, then approve again (or approve with false to cancel).',
  LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED:
    "Check the provider's tokenUrl, clientId, clientSecret and redirectUri (it must match the one registered with the provider), then sign in again.",
  LOUSHO_MCP_START_FAILED:
    "Run the server's command yourself to see why it fails; the message has its exit code and last stderr lines, and `connectTimeoutMs` bounds a server that never answers.",
  LOUSHO_MCP_CALL_FAILED:
    "Read the message: it names the server and tool; the `cause` is the MCP error (its `code`, e.g. -32000 'Connection closed' when the server exited). Check the server is running.",
  LOUSHO_MCP_AUTH_REQUIRED: "Sign the app in to the MCP server once: open the URL from agent.oauth.mcpSignInUrl('<server>') and let the callback store the token.",
  /** A workspace write named an expectedRevision that is no longer current. */
  LOUSHO_WORKSPACE_STALE_REVISION: 'Read the workspace again at its current revision, reapply the change and write with that revision as expectedRevision.',
  /** A workspace write would leave every file as it is. */
  LOUSHO_WORKSPACE_NO_CHANGE: 'Drop the write, or change at least one file so the tree differs from the current revision.',
  /** A workspace path, or a symlink in a workspace folder, leaves the workspace. */
  LOUSHO_WORKSPACE_PATH_INVALID: 'Use a forward-slash path relative to the workspace root, and replace symlinks that leave the workspace folder with the files themselves.',
  /** A workspace revision the source never recorded, or whose snapshot was pruned. */
  LOUSHO_WORKSPACE_REVISION_UNKNOWN: "Pick a revision from source.history(), or raise folderSource()'s keep to keep older snapshots readable.",
  /** A workspace folder's revision index or write journal is damaged. */
  LOUSHO_WORKSPACE_SOURCE_CORRUPT: 'Look at the file the message names under .lousho/revisions/; a set-aside journal can be inspected and deleted once the workspace looks right.',
  /** A workspace folder read went over a size or file-count limit. */
  LOUSHO_WORKSPACE_SOURCE_LIMIT: 'Move large or generated files out of the workspace folder, or raise the limit the message names on folderSource().',
  /** A database workspace source refused file content it cannot store, such as a NUL character. */
  LOUSHO_WORKSPACE_CONTENT_UNSUPPORTED: 'Remove the NUL characters from the file the message names; a database workspace source stores text only.',
  /** A workspace read through a source has validation errors. */
  LOUSHO_WORKSPACE_INVALID: 'Read error.problems: each has a code, a file and a field path. Fix those files and load the workspace again.',
  /** A page's agent reference names no agent folder, or no global agent version matches it. */
  LOUSHO_WORKSPACE_AGENT_UNRESOLVED: "Check the ref in the page's agents.json: a workspace or local agent needs its folder, and a global ref needs a globalRegistry with a version in its range.",
  /** A main harness lists an instruction file for which no text was supplied. */
  LOUSHO_WORKSPACE_MAIN_HARNESS_TEXT_MISSING: 'Pass the text of every file listed in main-harness.json instructions, keyed by main-agent/harness/<file>, or remove the name from the list.',
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
