# Eve-2 — adversarial audit of the fix rounds (2026-10-12)

Second competitor-style audit of the SDK. Round 1 produced ~166 findings
(`audit/eve/FINDINGS-*.md`); all were fixed and merged upstream (waves E1–E21
plus MAIN-HEALTH rounds 1–3, PRs up to #611). This round audits **the fix
code itself** — run leases, the `<id>.paused` marker, secure-by-default
routes, multi-approval pauses, abort handling — the least-tested surface.

## Verified findings (all reproduced on `main` @ f4c8eb10)

| # | Finding | Severity | Repro (`npx tsx audit/eve2/repro/<file>`) |
|---|---------|----------|-------------------------------------------|
| 1 | Session ownership check-then-act race — a concurrent first-touch runs a turn inside another user's session and receives their data | **Critical** | `f1-session-squat-toctou.ts` |
| 2 | `recordFailure` writes `lastError` onto a foreign run's checkpoint without lease fencing — permanently poisons it | High | `f2-recordfailure-poisons-foreign-checkpoint.ts` |
| 3 | `<id>.paused` marker lands after the pause checkpoint — a durable run is admitted beside the paused turn in the gap (or forever after a crash) | High | `f3-paused-marker-gap.ts` |
| 4 | Sub-agent grouped approvals execute schema-invalid edited args (validation skipped for `snapshot.subagent`) | High | `subagentGroupEditedArgs.ts` |
| 5 | Abort during tool execution never settles the run — `send()` and `approvals.resolve()` hang on a wedged tool | High | `abortDuringToolExecution.ts`, `abortDuringResumedTool.ts` |
| 6 | A re-paused run's checkpoint drops `approvalIds` — durable discovery names 1 of N approvals | Medium-High | `rePausedSubagentCheckpointIds.ts` |
| 7 | `uniqueToolCallIds` fragments an unindexed repeated-id stream delta into phantom calls | Medium | `streamToolCallIdRewrite.ts` |
| 8 | `isStreamingRequest` regex on the raw body rewrites a JSON reply into SSE on any nested `"stream":true` | Medium | `streamRegexFalsePositive.ts` |

Details + per-persona analysis (AI engineer / PM / engineer / designer):
`FINDINGS-durability-security.md`, `FINDINGS-runtime-tools.md`.

## Triage of round-1 findings

`audit/eve/TRIAGE.md` — 166 findings re-verified on current main:
**142 fixed**, 15 still-open (mostly medium/low, several CLI-owner items),
9 changed/partial. Notable still-open: `CORE-F8` (typed `output` lost on
`approvals.resolve()`), `TOOLS-F20` (credential broker injects secrets over
absolute-form `http://`), `PROV-F11` (`decide()` timeout/choices/429),
`CH-F14` (Slack raw-text replies), `CLI-F1` (`latest` npm tag = alpha.0,
owner action).

## Notes

- Finding 1 is an authorization-boundary breach (cross-principal data
  leak) — treat as security-sensitive.
- EVE-0 (resume divergence from round 1) verified FIXED: `<id>.paused`
  marker + `SessionAwaitingApprovalError` on every entry point.
- Repros are deterministic (mockModel/fileStore); no network needed.
