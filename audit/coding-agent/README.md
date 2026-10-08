# coding-agent — mini Claude-Code audit harness (live, OpenRouter)

A real-world coding assistant built on the **packed** `@lousho/build-ai-agent@1.0.0-alpha.18`
(`file:./lousho-build-ai-agent-1.0.0-alpha.18.tgz` in `audit/node_modules`), run live
against `openrouter/openai/gpt-4o-mini` (`OPENROUTER_API_KEY` in the repo-root `.env`,
loaded by `../_shared/env.ts`).

## The scenario

`index.ts` scaffolds a scratch project at `.runs/<ts>/project/` — a TypeScript
`sumRange` with an off-by-one (`i < to` instead of `i <= to`) and a failing
`node --test` suite — then drives the agent through a realistic workflow:

| Phase | What happens | Surface proven |
| --- | --- | --- |
| 1 | Session starts in `permissionMode: 'plan'`; agent inspects and diagnoses | fs tools read-only in plan mode |
| 1b | Agent is *ordered* to mutate anyway — `write_file`/`edit_file` are denied even though an `allow` rule matches | plan-mode gate + audit `mode`/`rule.index` |
| 2 | `setPermissionMode('default')`; `edit_file` pauses → harness approves via `agent.approvals.resolve()` → `node --test` runs | needsApproval pause → in-process resume |
| 3 | `write_file(NOTES.md)` pauses durably (`store/approvals/<id>.json`); a **second node process** (`resume-worker.ts`) reopens the session, sees `pending()`, gets `SessionAwaitingApprovalError` from `resume()`, resolves the approval, and finishes the turn | durable approvals + durable session, real cross-process resume |
| 4 | A fresh `createAgent()` on the same `fileStore` reopens the session and answers "what was the bug?" | session transcript persistence |
| 5 | Natural in-run compaction (tiny `contextWindow` to force it) + manual `session.compact()` | compaction events + API |

Plus a `deny` permission rule protecting `test/` and a `loop-guard` `preToolCall`
hook — both fire in the transcript.

## Run

```bash
cd E:\agent-sdk\audit
npx tsx coding-agent/index.ts      # ~2-4 min, writes .runs/<ts>/ + console PASS/FAIL lines
node coding-agent/repro/resolve-outside-session.ts   # offline footgun probe (mockModel)
node coding-agent/repro/pending-then-resolve.ts      # pending() does not bind the session
node coding-agent/repro/confinement.ts               # Windows path-escape battery (offline)
node coding-agent/repro/shell-windows.ts             # cmd.exe quoting / allow-prefix escapes
```

Artifacts per run: `.runs/<ts>/events.jsonl` (every permission decision, mode
change, approval decision), the untouched `project/` (kept for inspection) and
`store/` (the fileStore: sessions/checkpoints/approvals JSON).

`fixture-repo/` + `repro/malformed-tool-calls.*` remain from an earlier
local-model harness iteration and still run offline.
