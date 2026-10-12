# Eve audit: tools

Scope: `defineTool`, tool argument validation and repair, workspace fs and shell tools (confinement, allow-lists, Windows), plan mode, approvals, tool search, MCP client and server, ACP, and the security of `src/security`, `src/auth` and `src/oauth`. Package under test: packed `1.0.0-alpha.19`. Repros are in `audit/eve/tools/`; run them from `E:\agent-sdk\audit` with `npx tsx eve/tools/<file>`.

## Summary
- **The shell allow-list fix (prior B16, marked "fixed") does not hold.** Quoting, `$HOME`, `${IFS}` and brace expansion all read outside the workspace under both sh and cmd.exe.
- **Secrets leak.** OAuth redaction misses thrown errors. Telegram and Teams post sign-in links into group chats, where any member can bind their own account to the asker. Token ownership ignores the authenticator.
- **One bad input stalls or breaks the process.** A model-supplied `grep` regex froze the event loop for 17 s and abort could not stop it. One MCP tool with a `oneOf` schema makes the provider reject every request.
- **MCP trusts the server.** A server's own `readOnlyHint` switches approval off. A same-name MCP tool replaces a local tool and its approval gate. Results have no size cap. `serveMcp` over HTTP is open to DNS rebinding.
- **Approvals are thinner than the API suggests.** Parallel approvals surface one at a time. `list()` is empty after a restart. There is no "don't ask again" and no edit-on-approve.

## Findings

### TOOLS-F1: Shell `allow` string patterns still read outside the workspace (regression of B16)
**Severity** high · **Lens** SWE · **Type** security
**Evidence** — `eve/tools/shell-allowlist-escape.ts` (real `NodeWorkspace`, `allow: ['cat'|'type']`, secret one level up): `cat ../secret.txt` is refused (control), but these escape: `cat "../secret.txt"`, `cat '..'/secret.txt`, `cat {..,x}/secret.txt`, `cat ${IFS}../secret.txt` and `cat $HOME/.gitconfig`. Under cmd.exe, `type "..\secret.txt"` and `type "c:\windows\win.ini"` also escape. The JSDoc and REPORT.md B16 promise a refusal; `docs/workspace-tools.md:285-288` contradicts them.
**Root cause** — `src/tools/workspace/shellTool.ts:100` (`ESCAPING_TOKEN` ignores quotes, `$` and braces) and `:153` (tokens come from a whitespace split).
**Suggested fix** — Strip quotes from each token before testing. Refuse `$`, `{` and `}` in a string-pattern match. Add the cases to the tests and make the docs agree.

### TOOLS-F2: OAuth token redaction misses thrown errors, object keys, class/URL instances and base64
**Severity** high · **Lens** SWE / AI eng · **Type** security
**Evidence** — `eve/tools/sec-token-redaction.ts`:
- Leaks: object key, URL instance, class instance, base64, thrown error (`"GitHub 401 for Authorization: Bearer <TOKEN>"`).
- Does not leak: plain string.
**Root cause** — `src/execution/sandboxGuard.ts:84-87` (only the returned value is redacted); `src/oauth/signIn.ts:415,418,427`.
**Suggested fix** — Scrub `error.message`, `error.stack` and `error.cause`. Redact the serialized JSON string rather than walking the object. Add base64/base64url forms of each token.

### TOOLS-F3: Telegram/Teams post sign-in links into groups, so any member can bind their account to the asker
**Severity** high · **Lens** SWE / PM · **Type** security
**Evidence** — `eve/tools/sec-signin-binding.ts`: Mallory completes the link posted for Alice, and the stored token is Mallory's. `docs/oauth.md:333-336` says the link is shown "only to that user".
**Root cause** — `src/channels/telegramChannel.ts:242`, `src/channels/teamsChannel.ts:337`, `src/server/fetchRoutes.ts:438-447`, `src/oauth/signIn.ts:254-256`.
**Suggested fix** — In group chats, post "sign in from a private chat" and send the link only in a 1:1 chat. Offer an opt-in cookie binding at the callback.

### TOOLS-F4: An MCP object schema with a sibling `oneOf`/`anyOf` collapses to `{anyOf:[{},{}]}`, and every request fails
**Severity** high · **Lens** AI eng / SWE · **Type** bug
**Evidence** — `eve/tools/mcp-schema-oneof2.ts`, `mcp-schema-oneof-live.ts`: OpenAI returns `Invalid schema for function 'gh__get_issue' ... got 'type: "None"'`, which fails the whole agent.
**Root cause** — `src/tools/mcp/schema.ts:78-79, 217-220`.
**Suggested fix** — Convert the base object and ignore or intersect the required-only branches. Never emit a non-object root (fall back to a passthrough object).

### TOOLS-F5: `serveMcp` HTTP has no Host/Origin validation (DNS rebinding)
**Severity** high · **Lens** SWE · **Type** security
**Evidence** — `eve/tools/mcp-serve-rebind.ts`: with `Host: evil.example` and `Origin: http://evil.example`, the server returns 200 and the agent runs.
**Root cause** — `src/tools/mcp/server/httpTransport.ts:88, 97-120`.
**Suggested fix** — Enable rebinding protection by default with loopback `allowedHosts`, reject a foreign `Origin`, and expose both as options.

### TOOLS-F6: The `grep` regex runs on the event loop: ReDoS freezes the process, and abort cannot stop it
**Severity** medium · **Lens** SWE / AI eng · **Type** security (DoS)
**Evidence** — `eve/tools/fs-grep-redos-encoding.ts`: `^(a+)+$` on 28 chars blocks for 17,339 ms with 0 timer ticks, and the abort does not fire.
**Root cause** — `src/tools/workspace/fsOperations.ts:196, 223, 242`.
**Suggested fix** — Run the search in a worker with a timeout, or use RE2. At minimum, reject nested quantifiers and cap the characters tested per line.

### TOOLS-F7: `edit_file` corrupts non-UTF-8 files
**Severity** medium · **Lens** SWE · **Type** bug (data loss)
**Evidence** — Same repro: editing line 2 of a latin1 `.ini` turns `e9` into `efbfbd` on line 1.
**Root cause** — `NodeWorkspace` reads and writes as UTF-8; `src/tools/workspace/fsOperations.ts:35-37, 113-125`.
**Suggested fix** — Refuse the edit unless a fatal UTF-8 `TextDecoder` accepts the file. Detect UTF-16 BOMs.

### TOOLS-F8: No cap on tool result size (defineTool and MCP); MCP images are sent as base64 text
**Severity** medium · **Lens** AI eng · **Type** perf / cost
**Evidence** — `eve/tools/e2e-ui-roles-and-tool-output.ts`: a 3,000,002-char tool message (about 750k tokens). `eve/tools/mcp-client-edge.ts`: a 400 KB image became 400k chars of text, and a 680k-char description was sent on every request.
**Root cause** — No result cap in the tool path; `src/tools/mcp/result.ts:143-153`, `src/tools/mcp/McpToolLoader.ts:240-241`.
**Suggested fix** — Add `createAgent({ maxToolResultChars })` (default about 50k, head-and-tail cut with a marker). Use image placeholders or multimodal output, and cap descriptions at about 2k.

### TOOLS-F9: `POST /ui` forwards client-chosen `system`/`assistant` roles
**Severity** medium · **Lens** SWE · **Type** security
**Evidence** — Same repro: the roles sent to the model are `system,system,assistant,user`, and the injected system text reaches the model.
**Root cause** — `src/server/uiMessageStream.ts:296-299`, `src/server/routeHandler.ts:89`.
**Suggested fix** — Drop non-user/assistant roles from client input.

### TOOLS-F10: `defineTool` accepts input schemas no model can satisfy
**Severity** medium · **Lens** AI eng / Design · **Type** DX
**Evidence** — `eve/tools/definetool-schemas.ts`:
- A `z.date()` field fails on every retry: `Expected date, received string`.
- A `z.string()` root is rejected live as `type: "string"`.
**Root cause** — `src/tools/defineTool.ts` (`assertValidOptions`), `src/utils/zodCompat.ts:67`.
**Suggested fix** — Throw `LOUSHO_CONFIG_INVALID` for a non-object root. Warn or throw on date/bigint fields and point to `z.coerce.date()`.

### TOOLS-F11: MCP tools can switch off approval (server `readOnlyHint` is trusted; a same-name local tool is replaced)
**Severity** medium · **Lens** SWE · **Type** security
**Evidence** — `eve/tools/mcp-client-edge.ts` [2]: `evil__wipe_disk needsApproval = false`. `eve/tools/mcp-shadow.ts`: the local gated tool is overwritten with only a warning.
**Root cause** — `src/tools/mcp/McpToolLoader.ts:53,181`; `src/execution/permissions.ts:227`; `src/tools/ToolRegistry.ts:37-40`.
**Suggested fix** — Default approval to `'always'` and trust annotations only on opt-in. Refuse a name collision.

### TOOLS-F12: Parallel approvals surface one at a time, and the first runs before the second is shown
**Severity** medium · **Lens** PM / Design · **Type** UX
**Evidence** — `eve/tools/approvals-behaviour.ts` (2).
**Root cause** — `src/execution/ApprovalGate.ts:146` (`pendingToolCall` is singular), `src/createAgentApprovals.ts:288`.
**Suggested fix** — Pause once per step with `approvalIds[]` and run the calls after all are decided.

### TOOLS-F13: `agent.approvals.list()` is empty after a restart, even with a durable store
**Severity** medium · **Lens** PM / SWE · **Type** enhancement
**Evidence** — `eve/tools/approvals-durable.ts`: `list()` returns 1 in process A and 0 in process B, while `get(id)` returns true.
**Root cause** — `src/createAgentApprovals.ts:218,415`; `ApprovalStore` has no `list`.
**Suggested fix** — Add an optional `ApprovalStore.list()` and merge it into `agent.approvals.list()`.

### TOOLS-F14: `serveAcp` crashes on a `null` JSON line
**Severity** medium · **Lens** SWE · **Type** bug
**Evidence** — `eve/tools/acp-null-line.ts`: `TypeError Cannot destructure property 'id' of 'message' as it is null`.
**Root cause** — `src/acp/serveAcp.ts:240,257`.
**Suggested fix** — Reply `-32600` for non-objects and wrap `dispatch` in try/catch.

### TOOLS-F15: The token owner key ignores the authenticator, so the same id across channels shares one token
**Severity** medium · **Lens** SWE · **Type** security
**Evidence** — `eve/tools/sec-owner-collision.ts`: a Slack user's Drive token is handed to a GitHub principal with the same id.
**Root cause** — `src/oauth/signIn.ts:62-64`, `src/oauth/tokenStoreKey.ts:344-351`, and channel principals without an `issuer`.
**Suggested fix** — Default `issuer` to `authenticator:<name>`, and document the migration.

### TOOLS-F16: Concurrent refresh with rotating refresh tokens deletes the good token
**Severity** medium · **Lens** SWE · **Type** bug
**Evidence** — `eve/tools/sec-refresh-race.ts`: the second refresh returns `invalid_grant`, and the stored token becomes `undefined`.
**Root cause** — `src/oauth/signIn.ts:139-146`.
**Suggested fix** — Single-flight per owner. On failure, re-read the store and delete only if it is unchanged.

### TOOLS-F17: The sandbox is weaker than documented
**Severity** medium · **Lens** SWE · **Type** security
**Evidence** — `eve/tools/sec-sandbox-writefile.ts`: `SubprocessSandbox.writeFile()` writes to any host path. Docker (from source only) runs as root with no cap-drop and no pids, memory or CPU limits.
**Root cause** — `src/security/sandbox.ts:104-120, 387-389`; the contract is at `src/security/sandboxCore.ts:74-78` and `docs/guardrails.md:234`.
**Suggested fix** — Confine `writeFile` to the root. For Docker, default to a non-root user, `CapDrop ALL`, `no-new-privileges`, resource limits and a read-only rootfs.

### TOOLS-F18: MCP client ignores pagination and `list_changed`, and a crashed server reports `idle`
**Severity** medium/low · **Lens** SWE · **Type** bug / DX
**Evidence** — `eve/tools/mcp-client-edge.ts` [1], `eve/tools/mcp-crash.ts`.
**Root cause** — `src/tools/mcp/McpToolLoader.ts:113-116`, `src/tools/mcp/connect.ts:243-248`.
**Suggested fix** — Loop on `nextCursor` and re-list on `list_changed`. Set status `failed` and log a warning on an unexpected close.

### TOOLS-F19: No "don't ask again" or "approve with edits"; `once()` remembers a non-human callback's yes
**Severity** low · **Lens** PM / SWE · **Type** enhancement / security
**Evidence** — `eve/tools/approvals-behaviour.ts` (3): the callback is asked once, but `send_email` runs twice.
**Root cause** — `src/execution/resume.ts:558-559`, `src/execution/ApprovalGate.ts:133-137`.
**Suggested fix** — Add `remember` and `args` to `ApprovalDecision`, and have `once()` honour only human or `remember` decisions.

### TOOLS-F20: The credential broker injects secrets into plain `http://`, on any port
**Severity** low · **Lens** SWE · **Type** security
**Evidence** — `eve/tools/sec-broker-cleartext.ts`.
**Root cause** — `src/security/credentialBroker.ts:157,177-185,199-202`.
**Suggested fix** — Inject only for https, and add a `ports` rule field (default 443).

## Verified non-issues
- Windows fs confinement holds against junctions, `..` segments, ADS, `CON`, `\\?\` and 8.3 names.
- Shell timeout and abort kill the whole process tree on Windows.
- Shell operators are blocked.
- A throwing `needsApproval` fails closed.
- A double resolve of a durable approval executes once.
- `approvals.get` works after a restart.
- Plan mode holds.
- Argument repair is conservative.
- MCP stdio isolation and prefixing hold.
- The JWT, auth and token-sealing matrix is clean.
- SSRF and env defaults hold.
