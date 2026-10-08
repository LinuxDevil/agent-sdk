# FINDINGS — coding-agent harness (packed SDK `1.0.0-alpha.18`, live on OpenRouter `gpt-4o-mini`)

Harness: `index.ts` (5 phases) + `resume-worker.ts` (real second process). Fixture: `project/` with a TS off-by-one bug and a failing `node --test` suite. All checks PASS in `.runs/live-run5.txt`; offline probes in `repro/`.

Severity key: critical / high / medium / low.

---

### F1: Resolving a session-paused approval from a restarted process silently deletes the whole turn from the transcript
- **Severity:** high · **Type:** bug / footgun
- **Evidence:** `node coding-agent/repro/resolve-outside-session.ts` — a `session.send()` turn pauses on `write_file`; a *new* agent on the same `fileStore` calls `agent.approvals.resolve({ id, approved: true })` without opening the session first. The tool **runs** (`a.txt` becomes `new`), the run finishes (`stop`), but `session.load()` afterwards returns **0 messages** — the user message, the tool call, its result and the final assistant text are all gone. `pending()` returns `null`, so nothing looks wrong.
- **Root cause:** `createAgentApprovals.resolve()` binds a paused turn to its session only through the in-memory `sessions` map (`src/createAgentApprovals.ts:285-292`). After a restart the map is empty, so it falls through to a bare `next()` — `resumeAfterApproval` continues the run outside the session, and `resume.ts` proactively invalidates the `<sessionId>.turn-<n>` checkpoint (see `src/execution/ApprovalGate.ts:140-149`), so the turn is never recorded anywhere.
- **Docs:** `docs/sessions.md` "Durable sessions" *does* warn ("open the session and call `resume()` once before resolving"), but nothing in the API enforces or even hints at it at the call site.
- **Suggested fix:** when `snapshot.sessionId` matches a `<id>.turn-<n>` checkpointed-session turn and no session binding exists, either auto-bind (resolve can construct the `ApprovalSession` itself — it has the store) or throw a descriptive error naming the session id and the required `session.resume()` step. Silent transcript loss is the worst of the three options.

### F2: `session.pending()` shows the paused turn but does NOT bind it — only a throwing `resume()`/`send()` does
- **Severity:** medium · **Type:** DX / API design
- **Evidence:** `node coding-agent/repro/pending-then-resolve.ts` — `await session.pending()` returns `{status:'awaiting-approval', approvalId}`, then `approvals.resolve()` still loses the turn (transcript length 0). Binding only happens as a side effect of `resume()`/`send()`/`stream()` throwing `SessionAwaitingApprovalError` (`src/createAgentApprovals.ts:338-340`). The natural "check what's pending, then resolve it" flow a developer writes is exactly the losing flow.
- **Suggested fix:** make `pending()` (or an explicit `session.claimPending()`) register the binding, or fold this into the F1 fix.

### F3: `agent.approvals.list()` is process-local; a restarted process cannot enumerate durable pending approvals
- **Severity:** medium · **Type:** enhancement
- **Evidence:** live, in `resume-worker.ts` output: `approvals.list() after restart: []` while `approvals.get(<id>)` returns the record via `store.load`. Source: `src/createAgentApprovals.ts:314` — `list: async () => [...pending.values()]` reads only the in-memory map. A crash-recovery CLI must know approval ids out of band (e.g. via `session.pending()`), and if the pause came from `agent.send(msg, { sessionId })` there is no session to ask — `agent.resume(id)` throws `SessionAwaitingApprovalError`, which at least carries the id.
- **Suggested fix:** add `list`/`scan` to `ApprovalStore` (the file store can enumerate `approvals/*.json`; the docs already promise "only one caller gets the record") and merge it into `approvals.list()`.

### F4: Plan mode has no read-only shell affordance — a coding agent cannot even run `node --test` or `tsc --noEmit` while planning
- **Severity:** medium · **Type:** enhancement
- **Evidence:** live — in plan mode the `shell` tool is denied wholesale (`permission shell` would deny; `permissionModeVerdict` at `src/execution/permissions.ts:221` refuses every non-read-only tool). `createShellTool` offers no way to mark a command subset read-only, and a user wrapper can't either: plan mode trusts `metadata.mcp.annotations.readOnlyHint`, which `createShellTool` never sets and its options don't accept.
- **Suggested fix:** `createShellTool({ readOnly: (command) => /^node --test|^tsc --noEmit|^git (status|diff)/.test(command) })`, applied before the mutating verdict — or let the tool accept `annotations` and let plan mode AND it with the allow/deny policy.

### F5: An approval-paused call is audited as `decision: 'default'` — indistinguishable from a call that ran freely
- **Severity:** low · **Type:** DX / audit correctness
- **Evidence:** live log line `permission edit_file -> default` immediately followed by `approval.requested`. Source: `src/execution/permissions.ts:326` — the entry records `rule?.action ?? 'default'`; a pause driven by the tool's own `needsApproval` (no `ask` rule) gets `'default'`, same value as an ungated call. Consumers building a permission audit log cannot tell "paused for a human" from "ran without review" without correlating `approval.requested` events.
- **Suggested fix:** report `'ask'` (or a new `'paused'`) as the decision when the outcome is a pause, whatever drove it.

### F6: Resumed approvals restart as a fresh run — second `run.start`, step numbering back at 1
- **Severity:** low · **Type:** docs / UX
- **Evidence:** live transcript — after `approval.requested`/`resolve`, the continuation emits `run.start` and `-- step 1` again within the same logical session turn (run1 showed `-- step 4` … `-- step 14` each twice). `docs/streaming.md`/`docs/sessions.md` don't mention that one turn can yield N `run.start`/`run.done` pairs to `session.on()` listeners.
- **Suggested fix:** document it, or add `resumed: true` / `continuesApprovalId` to the continued `run.start` so UIs can stitch the turns.

### F7: Repeated identical tool calls each demand a fresh approval — no "approve, don't ask again" at resolve time
- **Severity:** low · **Type:** enhancement
- **Evidence:** run1 (`.runs/run2.txt` vintage behavior, reproduced in live-run1): gpt-4o-mini re-issued the identical `edit_file` after it succeeded once, producing **12** `approval.requested`/`resolve` round-trips for one logical edit. `once()` exists for `needsApproval` predicates (`src/tools/approvalPolicies.ts:29-49`) but there is no session/run-scoped "always allow this call signature" in `resolve()` or in `ask()` rules.
- **Suggested fix:** `agent.approvals.resolve({ id, approved: 'always' })` adding a run/session-scoped allow entry — the Claude Code "Yes, and don't ask again" affordance.

### F8: Compaction thrash — no-op compactions keep firing every model call
- **Severity:** low · **Type:** perf / correctness-of-signal
- **Evidence:** live (`live-run4/5.txt`): `compaction.done 1384 -> 1384` and `1561 -> 1561` — `prune-tool-results` ran, could not get below the threshold, reported success, and fired again at the next model call. Also `trigger` is typed `trigger?: 'manual'` (`src/execution/agentEvents.ts:327,337`), so automatic compactions carry *no* trigger value — callers cannot positively label them.
- **Suggested fix:** skip re-firing when the last compaction of the run couldn't reduce below threshold (or surface `trigger: 'auto' | 'manual'` and a `noop: true` on `compaction.done`).

### F9: String `allow` prefixes on `createShellTool` accept arbitrary trailing args — an "allowlisted" command can write outside the workspace
- **Severity:** medium (hardening) · **Type:** security / docs
- **Evidence:** `node coding-agent/repro/shell-windows.ts` — with `allow: ['node --test', 'npm test', 'git diff']`, `node --test --test-reporter-destination=../escaped-report.txt` and `git diff --no-index --output=../escaped-diff.txt …` both ran and wrote files **outside** the root (`escaped-*.txt exists=true`). `matchesPrefix`/`isAllowed` (`src/tools/workspace/shellTool.ts:59-79`) only guard shell operators; program flags that do I/O are unrestricted.
- **Docs:** the tool honestly disclaims "a convenience, not a security boundary" — but `docs/build-a-coding-agent.md` and `workspace-tools.md` present `allow` lists as the suggested production pattern ("commands you trust"), which under-sells that *trusting the program* still means trusting every flag.
- **Suggested fix:** doc example should pair `allow` with anchored RegExp patterns that pin the argument shape (e.g. `/^node --test(\s+[\w./-]+)?$/`), or the tool could offer `allowExact` that forbids extra args.

### F10: (informational) Denied-call telemetry and rule bookkeeping are accurate
Verified live in phase 1b: `write_file` to `PLAN.md` matched `allow` rule index 1 yet was denied by plan mode, and the audit entry kept `rule.index` (`permission write_file -> deny mode=plan rule=1`) exactly as `docs/permission-modes.md` §"audit log" specifies. Denials reach the model as `kind: 'denied'` `ToolDeniedError` tool results and it recovers gracefully.

### F11: (informational) Workspace confinement is solid on Windows
`node coding-agent/repro/confinement.ts`: every escape refused — `..` climbs, mid-path `..`, backslash variants, sibling-prefix dirs, absolute/drive-letter/drive-relative/UNC/`\\?\`/`file://` paths, dot-space segments (`.. /x`), NTFS ADS (`::$DATA`), device names (`NUL`, `con.txt`), junction traversal for read/write/list, dangling-symlink writes. `grep`/`glob` don't follow junctions. `commandEnv` scrub verified: `echo %FAKE_SECRET_TOKEN%` expands empty inside the workspace shell. Only known hole: hardlinks (documented as undetectable) and the shell itself (documented as unsandboxed).

### F12: (minor DX) `needsApproval` predicate argument shape is inconsistent across tool factories
`createFsTools` predicates receive the parsed **args object** (`{ path }`), `createShellTool`'s receives the **command string** — typed correctly, but a surprise when writing shared policy helpers. Consider accepting `(args, command)` in the shell predicate for symmetry.

---

## What worked cleanly
- `createAgent({ model: 'openrouter/openai/gpt-4o-mini' })` resolves the provider from `OPENROUTER_API_KEY` with zero config.
- `NodeWorkspace` + `createFsTools` + `createShellTool`: seven tools, correct schemas, numbered-line reads, good error text (`old_string` mismatch explains itself to the model).
- `permissionMode: 'plan'` → `session.setPermissionMode('default')` mid-session works exactly as documented, incl. the `mode=plan` deny audit fields.
- `fileStore` durability is real: `approvals/<id>.json` + `checkpoints/<id>.turn-<n>.json` + `sessions/<id>.json` all inspectable; a genuinely separate `node` process resumed the paused session turn to completion.
- `session.pending()` / `SessionAwaitingApprovalError.approvalId` behave per docs; `pending()` on the stale parent session correctly returns `null` after the child resolved.
- Deny rules and a `preToolCall` hook deny both surface as readable `tool.error` results the model can recover from.
- `WorkspaceCheckpoints` recorded the file backups per turn.
- Manual `session.compact()` and in-run `prune-tool-results` both work; `compaction.start`/`done` events flow to `session.on()` listeners.
