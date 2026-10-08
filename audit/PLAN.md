# Audit fix plan: 2026-10-08

## Sources

The findings come from these audit reports:

- `audit/*/FINDINGS*.md`, from the local LM Studio harnesses.
- The OpenRouter audit written by the other session (`companion/`, `incident-responder/`, `repo-maintainer/`, `research-analyst/`, `coding-agent/FINDINGS.md`, `hostinger-monitor/FINDINGS.md`).
- `_cross/FINDINGS.md`.

## Rules for every PR

**Base and scope.** Base each PR on `origin/main`. Use one PR per work item. Write a failing test first, then the fix.

**Changelog.** Add an entry under `## [Unreleased]` in `CHANGELOG.md`.

**Required gates:**

- `npx tsc --noEmit`
- `npm run typecheck:tests`
- `npm run lint`
- `npx vitest run <touched dirs>`
- the full `npx vitest run`

**Conditional gates:**

| When | Run |
|---|---|
| The public API changes | `npm run api:update` |
| Docs change | `npm run docs:llms` and `npm run docs:verify-snippets -- --skip-build` |
| `registry/` changes | `npm run registry:check` (or the registry build script) |

**Shipping.** Rebase on `origin/main`, push, open a PR, and squash-merge it right away. Publishing to npm stays with the owner.

## Wave 1: security and data integrity (high)

| ID | Item | Sources |
|---|---|---|
| A1 | Route handler: an approval decision must belong to the session in the URL. Add an `authorizeSession(principal, sessionId)` hook. Redact raw provider errors on the wire. Return consistent statuses (409) for concurrent decisions. | support F5, F6, F10, F11 |
| A2 | Registry receipt: `exec: true` approval can't be overridden by directory rules, modes or `approve`. | coding-local F1 |
| A3 | `loadAgentDir`/`resolveAgentDir`: forward every `createAgent` override (guardrails, onEvent, retry, ...). | coding-local F2 |
| A4 | coding-kit hardening: deny writes to its own config, approver, hooks and receipt. Make the loop guard per run, exempt tests and skip `resumedAfterApproval`. Drop `git diff` from the allowlist. | coding-local F4, F5, F6 |
| A5 | Shell tool: treat `%` and `^` as operators under cmd. Add exact-match patterns. Document that a string pattern allows any arguments. Have the tool description name the shell. | coding-local F6, F16; coding F9 |
| A6 | Structured output with optional fields: normalize `required` and make optional fields nullable for strict `json_schema`. | repo-maintainer F1 |
| A7 | Handoff routing note: stop sending a mid-conversation `system` message, which Qwen/Llama templates reject. Keep memory after a handoff. | support F1, F9 |

| A8 | Flows: tool steps go through the approval/permission gate (fail closed without an approver), args validated, required inputs enforced, `signal` support, unique step ids | invoice F1,F2,F4,F15 |
| A9 | `withFallback` per-call state + serving-model attribution; undeliverable file parts throw instead of silent placeholder | invoice F5,F9 |

Later additions to C/D waves from invoice: F6 `outputRepaired` flag + docs, F7 root-union schema, F8 `z.date()` warning, F10 error-body snippet (with C1), F12 schema-in-prompt toggle, F17 provider `fetch` option / headers timeout as timeout (with C2).

## Wave 2: durable sessions and approvals

| ID | Item | Sources |
|---|---|---|
| B1 | If the continuation after an approval fails, the executed tool turn is erased. If a session-paused approval is resolved from a restarted process, the turn is deleted. | support F4; coding F1, F2 |
| B2 | A stuck failed turn blocks the session and new messages are dropped. Concurrent sends on one session lose a turn; add a per-session lock or compare-and-set. | support F2, F3 |
| B3 | Parallel tool results are checkpointed by `toolCallId`, so finished calls are not re-run on resume. | log F9 |
| B4 | A client disconnect during a side-effecting tool drops the turn. | support F7 |

## Wave 3: provider resilience and local models

| ID | Item | Sources |
|---|---|---|
| C1 | Error classification: recognize llama.cpp/LM Studio overflow wording in both the 500 and the stream paths. Surface ECONNREFUSED. Fix `[object Object]`. Keep the upstream body. | X1; log F2, F12; support F12; coding-local F8; repo F2 |
| C2 | Retries: disable the AI SDK's own `maxRetries` when the SDK retries. Retry a streamed step that fails before any content (ignore empty reasoning chunks). | log F1, F11; support F8; hostinger F4 |
| C3 | Unknown-model context window: warn once, accept `contextWindow`, document `registerModel`. Make the compaction estimate include tools and the system prompt. | X2; log F3, F4; coding-local F19 |
| C4 | Compaction: don't latch off after one summary rejection. Count the summarizer's usage. Make `done.strategy` match. Pass `onCompaction` through. Leave pruned-result stubs. | log F5, F6, F13, F14, F20 |
| C5 | `OpenAIProvider({ api: 'chat' })`, plus a "Local models" docs section (`OPENAI_BASE_URL`, LM Studio, vLLM, llama.cpp). | X3, X4 |
| C6 | `createAgent({ modelSettings: { maxTokens, temperature } })`. Omit undefined keys. | log F16; coding-local F11 |

## Wave 4: run loop and tools

| ID | Item | Sources |
|---|---|---|
| D1 | Invalid tool-argument JSON becomes a validation error instead of `{}`. A tool-not-found error suggests the closest name. | coding-local F7, F13 |
| D2 | A failed run reports partial usage. An aborted result keeps the reason. Abort gets a grace period for tools that ignore the signal. | coding-local F10; log F10, F17 |
| D3 | Hitting `maxSteps` with `output` makes one final call with no tools to force an answer. Extract JSON from prose or `<think>` text before the repair call. | log F8, F21; docs F10 |
| D4 | MCP: forward the signal and a timeout to `callTool`. Stop duplicating text content. Sanitize tool names. Give start failures stderr, exit code and an error code. Add per-server include/exclude. | hostinger F1, F2, F5, F6, F7 |
| D5 | Schedules: report every non-`stop` finish. Make `stop()` awaitable. | hostinger F8, F9 |

## Wave 5: evals, typings, DX

| ID | Item | Sources |
|---|---|---|
| E1 | `lousho eval`: add a timeout option and a long default for record/live runs. Write a JUnit `<error>` when vitest fails. Make cassette slugs collision-safe. | docs F1, F2, F3 |
| E2 | `recordReplay` keeps reasoning and full usage. Fix the judge score parser. | docs F4, F12 |
| E3 | Declarations compatible with zod 4 (no inlined zod-3 generics), plus a pack-smoke `tsc` check with zod 4. | X5 |
| E4 | Tracing: `send({ parentSpanId })`. `execute_tool` error message. `approvals.get(malformed)` returns undefined. | research F1, F3; incident F1 |
| E5 | CLI: make `lousho add` work by default (registry URL fallback, flag checks before the manifest dump). `doctor` shows the base URL. | coding-local F3; X4 |

## Backlog (not in this round)

These are design-level enhancements:

- RAG primitives (docs F8).
- Tool-result validation in `output` (docs F9).
- A `streamModelCalls` option.
- Retry spans.
- Reshaping `toolCalls` (log F22).
- Free pricing for local models (X6).
- Drift on objects (docs F6).
- The other-session companion memory items.
- Plan-mode read-only shell.
