# coding-agent (local LM Studio): findings

These findings come from the harness `local-harness.ts`, which runs on the local
`qwen3.5-9b` model. `FINDINGS.md` and `index.ts` in this folder belong to a
separate OpenRouter session.

Outcome: in run 8 the agent fixed all 3 fixture bugs in 13 steps. It made 3
shell calls, and the allowlist policy approved all of them. I re-ran
`node --test test/*.test.js` in the workdir and 7 of 7 pass. The pristine
fixture fails 5 of 7. The test files in the workdir are byte-identical to the
fixture's.

Runs 1–7 died on the old LM Studio load (8K context split across 4 slots), so
I don't count them. Repro scripts are in `repro/`, and their captured output is
in `repro/*.out.txt`.

## Security

### F1: The registry receipt's "exec ⇒ always ask" rule is overridden by the item's own `agent.json` and `approve.ts`
- **Severity:** high.
- **Type:** security.
- **Evidence:** `repro/loadagentdir-overrides.ts`. The kit as installed runs shell with no approval (`perm=allow ran`). It pauses only with `approve: null` **and** `permissions: []`.
  - `docs/registry.md` promises that `exec: true` tools "always wait for approval".
  - `lousho add` even prints "approval: its tools run without asking".
- **Root cause:**
  - The receipt is enforced as a plain `'ask'` in `src/agentDir/registryEnforce.ts:323-324`.
  - Any `allow` rule then replaces that `'ask'` (`src/execution/toolCallExecution.ts:209`).
  - Those rules and the approver come from the same untrusted directory (`src/agentDir/loadAgentDir.ts:453,457`).
- **Fix:** make the receipt's approval requirement non-overridable. Directory rules, permission modes and the directory's own `approve` file must not satisfy it. Only a host-supplied approver may.

### F4: coding-kit lets the agent rewrite its own approver, hooks and permissions
- **Severity:** high.
- **Type:** security.
- **Evidence:** `edit_file approve.ts` → `return true` was auto-approved and applied. The next load warned "receipt mismatch" but still used the modified approver.
- **Root cause:**
  - In `registry/coding-kit/tools/fs.ts` the workspace root is the agent directory itself.
  - `approve.ts` only special-cases `*.test.js`.
- **Fix:**
  - Deny writes to `agent.json`, the root `*.ts` files, `instructions*`, `.lousho/` and `lousho-registry.json`.
  - Put the project workspace in a subfolder.
  - Treat a receipt mismatch as a hard failure for exec items.

### F6: String `allow` shell patterns accept any trailing arguments
- **Severity:** medium.
- **Type:** security / docs.
- **Evidence:**
  - `node --test --test-reporter-destination=../x` and `git diff --no-index --output=../x` both wrote files outside the root.
  - `git diff` is on the coding-kit allowlist.
  - cmd's `%VAR%` expansion passes the operator check.
- **Root cause:** `src/tools/workspace/shellTool.ts:56-63,77-80`.
- **Fix:**
  - Document that a string pattern means "this command plus any arguments".
  - Add exact-match and argument-validator patterns.
  - Treat `%` and `^` as operators under cmd.
  - Drop `git diff` from the kit.

## Bugs

### F2: `loadAgentDir()` / `resolveAgentDir()` silently drop most `createAgent()` overrides, including `guardrails`
- **Severity:** high.
- **Type:** bug / security.
- **Evidence:** passing `{ onEvent, guardrails }` → the guardrail is ignored and `onEvent` is called 0 times.
  - Only `approve, compaction, instructions, limits, maxSteps, name, permissionMode, permissions, provider, skills, tools` survive. `retry`, `reasoning`, `redactContent` and the rest are dropped.
  - The type and the docs both say "same options as createAgent()".
- **Root cause:** `src/agentDir/loadAgentDir.ts:418-439` (`assembleConfig`) copies a hand-picked list of keys.
- **Fix:** spread the remaining overrides, or throw on unsupported keys.

### F5: The coding-kit loop guard is process-global and blocks the third `node --test`
- **Severity:** medium.
- **Type:** bug.
- **Evidence:** three separately loaded agents, one call each → the third is denied by `loop-guard`.
  - Its instructions require running the tests before and after each change.
  - In the live kit run, the very first `node --test` was denied.
- **Root cause:** in `registry/coding-kit/hooks.ts`:
  - The hooks are built once at module load.
  - Calls are keyed by `sessionId ?? ''`.
  - `maxRepeats = 2`.
  - The post-approval re-fire counts twice.
- **Fix:**
  - Export a factory, or key by `runId`.
  - Exempt test commands.
  - Skip the re-fire when `resumedAfterApproval` is set.

### F7: Unparseable tool-call JSON silently becomes `{}`
- **Severity:** medium.
- **Type:** bug.
- **Evidence:**
  - Truncated JSON, JSON wrapped in a markdown fence, and JSON with a trailing comma all produce "path: Required".
  - `list_dir` with `{"path":"src"` (truncated) runs on the **root** and succeeds, and `tool.start.args` shows `{}`.
- **Root cause:** `src/execution/toolCallExecution.ts:175` → `src/execution/toolArgsValidation.ts:18-24` swallows the parse error.
- **Fix:**
  - Return a validation error that says "arguments are not valid JSON" and includes the raw text.
  - Optionally repair fences, trailing commas and double-encoded JSON.

### F10: A failed run reports no usage
- **Severity:** medium.
- **Type:** bug.
- **Evidence:**
  - About 7,100 tokens were spent before a provider error. The error carries no usage, and `run.done` has none either.
  - A continuation that failed after 4 model calls lost all of its usage.
- **Root cause:** `src/execution/agentRun.ts:414-417`.
- **Fix:** attach the partial usage to `run.done` and to the thrown error.

### F19: The compaction size estimate ignores tool schemas
- **Severity:** medium.
- **Type:** bug.
- **Evidence:** with a 4,096-token window and a threshold of 2,457, the prompt the provider reported was 3,055 tokens. Compaction never fired.
  - About 1,400 tokens of baseline is tool definitions.
- **Root cause:** `src/context/compaction.ts:354` counts `messages` only.
- **See also:** log-incident F4.

### F8: LM Studio's 500 error is classified `unknown`, and object errors become "[object Object]"
- **Severity:** low.
- **Type:** bug.
- **Evidence:** `repro/classify-lmstudio-error.out.txt`.
- **Root cause:** `src/execution/errors.ts:322-323` and `:459` (`String(cause)`).
- **See also:** `_cross` X1.

## DX

### F3: `lousho add` doesn't work out of the box
- **Severity:** high.
- **Type:** DX.
- **Evidence:** `registry.lousho.com` returns NXDOMAIN → `LOUSHO_REGISTRY_UNREACHABLE`.
  - The npm tarball doesn't ship `registry/dist`.
  - In a non-TTY session, `lousho add` prints the whole manifest and only then fails, asking for `--yes`. With `--yes` it fails again, asking for `--allow exec,fs-write`.
  - A kit installed without `node_modules` fails with a bare `Error` that has no code.
- **Root cause:** `src/cli/registry.ts:28`.
- **Fix:**
  - Make the domain live, or default to the GitHub raw URL.
  - Ship `registry/dist` as an offline fallback.
  - Check the flags before printing the manifest.

### F11: `createAgent()` has no per-call `maxTokens` / `temperature`
- **Severity:** medium.
- **Type:** DX.
- **Evidence:** a `preGenerate` hook was needed to set `maxTokens`.
- **Root cause:** the executor supports these settings (`src/execution/AgentExecutor.ts:236-237`), but `createAgent` never forwards them.

### F12: Compaction and cost budgets are silently inert for local models
- **Severity:** low.
- **Type:** DX.
- **Evidence:**
  - Unknown models fall back to a 128K context window.
  - `maxCostUsd` is skipped for unpriced models.
- **Root cause:** `src/execution/budget.ts:18`. Nothing warns that either check is inactive.

### F13: The tool-not-found error has no suggestion
- **Severity:** low.
- **Type:** DX.
- **Evidence:** `read-file` and `functions.read_file` get a bare "not found".
- **Root cause:** `src/execution/toolCallExecution.ts:543`.
- **Fix:** add a closest-match suggestion and list the available tools.

### F14: `createShellTool` / `createFsTools` erase their types
- **Severity:** low.
- **Type:** typings.
- **Evidence:**
  - The result type is `unknown`.
  - Args are untyped.
  - A `ctx` parameter is required.

### F15: The audit log never records how a paused call was decided
- **Severity:** low.
- **Type:** enhancement.
- **Fix:** add an `approval.resolved` event and audit entry.

### F16: The shell tool doesn't tell the model which shell it runs
- **Severity:** low.
- **Type:** DX.
- **Evidence:** on Windows the shell is cmd.exe, so single quotes and `$HOME` break.
- **Root cause:** `src/tools/workspace/shellTool.ts:161`.

### F17: The kit's `approve.ts` is ignored under `stream()`
- **Severity:** low.
- **Type:** docs.
- **Evidence:** documented only in `docs/approvals.md`.

### F18: A tool guardrail can't refuse a single call
- **Severity:** low.
- **Type:** enhancement.
- **Evidence:** a tool guardrail ends the whole run, while a hook denial lets the model continue.

### F20: No `reasoning.*` events for an always-reasoning model unless `reasoning` is set
- **Severity:** low.
- **Type:** DX.
- **Evidence:** the run reported `reasoningTokens: 761` and emitted no events.

## What held

- **File-tool confinement on Windows** rejected every attempt:
  - `..` traversal, absolute paths, drive paths, `C:rel`, `\\?\`, UNC, `file:///`, ADS (`::$DATA`), device names, prefix-sibling paths and NTFS junctions.
  - Hard links are documented.
  - Symlinks could not be tested without Developer Mode.
- **Process cleanup:** timeout and abort kill the whole process tree, grandchildren included.
- **Approval flow:** pause → `approvals.get` → `streamResolve` works. Usage adds up correctly across the pause.
- **`maxSteps`** ends a looping model.
