# Handoff: agent-sdk improvement loop

Written 2026-10-01 at the owner's request ("Stop and give me a handoff to a new agent"). The loop is stopped; nothing is in flight.

## What this loop is
Mission (owner's words): make `@loushy/build-ai-agent` the best TypeScript AI agent SDK, better than Vercel eve and MaxGfeller/open-harness, one batch of 1-point tickets per iteration. Full prompt: the `/loop` invocation in the original session; the mechanics are reproduced in `BRIEF.md` next to this file.

## Where everything lives
- `.agent-loop/STATE.md`: the tracker. Competitor matrix (51 rows, our cell + flipping ticket), ticket tree per epic with status and PR numbers, PR log, decisions, iteration log, next planned batch. Read it first; update it last.
- `.agent-loop/AUDIT.md`: the audit (at main `a03b1a3`, eve 0.69.0, open-harness 0.7.0): missing/better/remove, DX measurement, matrix with evidence links, differentiators, proposed tickets with acceptance criteria. `docs/plan/tickets.md` has the original tickets' acceptance criteria.
- `.agent-loop/reference-agents/`: the 3 reference agents in all 3 SDKs (ours type-checks).
- `.agent-loop/BRIEF.md`: the shared subagent brief (setup, conventions, verification list, PR format, "never delete branches", the `node:*` runtime constraint).
- `.agent-loop/syncverify.sh`, `.agent-loop/keepboth.py`: the orchestrator's merge helpers (see "How merging worked"). They hardcode the old scratchpad path `S=`; set it to this directory.
- Scorecard artifact for the owner: https://claude.ai/artifact/7Q5dKCXviY2DSMvPupoTE3 (private to the owner; regenerate from STATE.md if asked).
- This state is on branch `loush/blissful-volta-i76xiy` (pushed). Main is `0fc3acd` (PR #126).

## Status
- 11 iterations, 58 PRs merged (#68, #72–#128). Matrix: 34 ✅ / 7 ⚠️ / 10 ❌ of 51 (was 16/15/20). Differentiators shipped: 5 (durable sessions in one `store` option; record/replay evals with drift; OTel GenAI metrics + cost; Forge time-travel; edge-native agents with Worker parity).
- Open PRs: none. Main is green by the full local suite (~2500 tests, lint 0 errors / 400 warnings, fallow clean). CI runs only on PRs; the owner said not to wait for CI.
- Not started: the planned iteration-12 batch (D28 peer ranges + CI matrix, P5 Slack channel, P8 schedules, Y7 remote sub-agent, D47 remote eval target). The owner declined those five launches, then asked for this handoff. Ask before launching anything.
- Remaining: 48 one-point tickets (STATE.md "Ticket tree", ⬜ rows). Biggest remaining matrix gaps: `ai` peer ranges/zod 4 (D28, D29), reasoning control (V13), dynamic config (V15), credential brokering + sandbox hardening (X11, X12), remote sub-agents (Y7), ACP (Z6), registry (D50), UI bindings for Vue/Svelte + AI SDK UI stream (P1–P3), Slack/Discord channels (P5, P6), schedules (P8, P9), npm publish readiness (U20, D49: publishing itself is the owner's).

## Owner instructions in force
1. Never delete branches (any). ~95 merged `lou-*` branches remain on origin on purpose. (Five empty local branches from declined launches also remain in the main checkout: `lou-d28-provider-peers`, `lou-p5-slack-channel`, `lou-p8-schedules`, `lou-y7-remote-subagent`, `lou-d47-eval-remote-target`, all at main with zero commits.)
2. Do not wait for CI; iterate continuously.
3. README stays the short front page (D52); details go to docs/.
4. Never force-push main, rewrite history, change release/publish config or publish to npm without asking. Breaking changes pre-1.0 need a CHANGELOG entry with a migration note.
5. Jira: the connected Atlassian site has no `LOU` project; track in STATE.md.

## How an iteration ran
1. Read STATE.md; pick up to 5 unblocked tickets that do not touch the same files (rule: at most one ticket per batch edits `src/execution/AgentExecutor.ts` / `resume.ts` / `toolCallExecution.ts`; tickets editing `src/createAgent.ts` get told which region is theirs).
2. One subagent per ticket (`Agent` tool, `isolation: "worktree"`, model opus for runtime/API/security design, sonnet for well-specified work), each told to read BRIEF.md. Each runs `npm ci` in its worktree, implements, tests, runs the full verification list, opens a PR titled `[EPIC-x][LOU-y] …` with What/Why/Acceptance/How verified, and reports back. Subagents must not merge or delete branches.
3. Merge: `syncverify.sh <branch> <vitest paths…>` merges origin/main into the branch, auto-resolves CHANGELOG/docs by keeping both sides and regenerates `llms*.txt`, runs `npm ci` if package.json changed, `tsc`, targeted tests, and pushes only if they pass. Code conflicts are resolved by hand (additive lists: keep both; see STATE's iteration logs for examples). Then squash-merge via the GitHub MCP `merge_pull_request` with `expectedHeadSha`. Order PRs least-overlapping first.
4. Rebuild `dist/` (`npm run build`) in the orchestrator checkout before running Agent Forge typechecks: Forge resolves the SDK via `file:../..`.
5. Update STATE.md (matrix flips, ticket statuses, PR log, iteration log, next batch), commit on the state branch, push, give the owner the 5-line summary.

## Verification list (what "green" means)
```
npx tsc --noEmit; npm run lint (0 errors, warnings must not grow: 400 now)
npm run test:types; npx vitest run (after npm run build and the create-loushy-agent build)
npm run docs:verify-snippets -- --skip-build; npm run docs:llms:check
npm run test:coverage && npm run fallow
Agent Forge: npm run typecheck|typecheck:server|test -- --run|test:server --workspace apps/agent-forge
```
Known flaky under load (pass alone): `src/execution/guardrails.test.ts` child-process timeout test, `NodeWorkspace.test.ts` pid-file test. The `cloudflare.test.ts` `wrangler dev` test is the guard that nothing in the Worker bundle imports `node:*`; if it fails, that is real.

## Gotchas learned
- Nothing under `src/execution`, `src/providers`, `src/context`, `src/tools` (shared code) may import `node:*`: it breaks the Worker bundle (#107 fixed one; D51 added a bare-specifier leak check and a shim allowlist).
- `fallow` fails the gate on complexity and unused exports; it lists one pre-existing duplicate block in AnthropicProvider/OpenAIProvider that does not fail.
- Keep-both doc merges can duplicate a paragraph when both sides added the same section (happened once in docs/agent-forge.md). Check headings after.
- A merge commit must never be committed with conflict markers (happened once on V9; fixed in the next commit; the helper now checks).
- Subagents put `Co-Authored-By: Claude Opus 5.5` / `Sonnet 5.5` trailers (the model that did the work) rather than the brief's line; harmless.
- Lockfile: use `npx npm@11 install` for dependency changes; npm 10 strips `libc` fields.
- A stray `/resume.fixed.ts` (23 KB) sits at the filesystem root of the cloud container; the safety check blocks deleting it. Owner's call.
- The ai-sdk upgrade state: D22–D27 done (SDK owns tool/exec-context types; `generate()` and `stream()` work on `ai` v4 and v6/v7 via `src/providers/aiSdkCompat.ts`, tested on real `ai@7` installed as dev alias `ai-v7`); D28 (peer ranges + CI matrix) and D29 (zod 4) remain. Until D28, package.json still pins `ai ^4.3.19` and `@ai-sdk/* ^0.0.42`.

## Suggested first move for the next agent
Confirm with the owner whether to run the planned iteration-12 batch as listed in STATE.md, or a different set. Then continue the loop exactly as above.
