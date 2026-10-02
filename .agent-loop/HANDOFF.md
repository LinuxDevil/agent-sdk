# Handoff: agent-sdk improvement loop

Written 2026-10-02. The loop is finished: every ticket in STATE.md is merged, nothing is in flight, no pull requests are open.

## Where things stand
- Main: `332385c` (PR #181). 111 PRs merged by the loop (#68, #72-#181). Matrix 48 ✅ / 2 ⚠️ / 1 ❌ of 51 (was 16/15/20). 8 of 8 differentiators shipped. Lint 0 warnings, enforced. 2955 tests.
- Full local suite green at main (Windows, Node 26). CI runs only on PRs, was not awaited, and pins Node 22.
- Scorecard for the owner: https://claude.ai/artifact/7Q5dKCXviY2DSMvPupoTE3 (sources in `.agent-loop/scorecard/`: edit `data.json` through `sclib.py`, which builds `scorecard.html`).

## Files here
- `STATE.md`: the tracker. Read it first. "After the loop" lists the owner's actions and every known limit that has no ticket.
- `AUDIT.md`: the competitor audit from before these PRs (main `a03b1a3`, eve 0.69.0, open-harness 0.7.0). Re-run it before planning another round.
- `BRIEF.md`, `BASELINE.md`: what every subagent is given (Windows version).
- `syncverify.sh`, `mergepr.sh`, `health.sh`, `keepboth.py`, `statelib.py`: the orchestrator's helpers. They hardcode a scratchpad path `S=` and the worktree path `E:\agent-sdk\.claude\worktrees\loop-orch`; set both for your session.

## Owner instructions in force
1. Never delete branches (merged `lou-*` branches stay on origin; agent worktrees stay, only their `node_modules`/`dist`/`coverage` were removed to save disk).
2. Do not wait for CI.
3. README stays the short front page; details go to docs/.
4. Never force-push main, rewrite history, change release/publish config or publish to npm without asking. Breaking changes pre-1.0 need a CHANGELOG entry with a migration note.
5. Run batches without check-ins (given 2026-10-01 for the remaining tickets; ask again before starting a new round, since none is planned).

## How an iteration ran on this machine
1. Read STATE.md; pick tickets that do not touch the same files (one "hub" ticket at a time for `AgentExecutor.ts` / `resume.ts` / `toolCallExecution.ts` / `createAgent.ts`; one `package.json` ticket at a time). Keep five agents busy: refill a slot as soon as a PR merges.
2. One subagent per ticket in its own worktree (opus for runtime/security/API design, sonnet for well-specified work), told to read BRIEF.md and BASELINE.md, to open a PR with `gh`, and not to merge.
3. `mergepr.sh <pr> <branch> <vitest paths>`: merges main into the branch on a detached HEAD, keeps both sides of doc conflicts, regenerates `llms*.txt`, runs tsc and the targeted tests (retrying when vitest dies without a summary), pushes, squash-merges with the head SHA, and cleans the agent worktree's installs. Code conflicts are resolved by hand.
4. `health.sh <label>` after each group of merges: the full verification list plus the four Agent Forge checks. Anything it finds is fixed in a `[HEALTH]` PR before more merges.
5. Update STATE.md (`statelib.py`) and the scorecard (`sclib.py`), commit on this branch, push.

## Lessons from this run
- Agent Forge is not in CI and was broken twice by tickets that did not run its typechecks; the brief now makes them mandatory.
- A PR that changes build output (tsup config, package exports) or is repo-wide needs the full health run on the synced branch before merging, not targeted tests.
- Check a helper's failure detection against colored output; an early version merged a PR whose only failures were a stale-`dist` import-graph test.
- Agents that are told a size limit will report a split instead of shipping too much: D28 became six tickets and landed cleanly.
- Disk: each agent worktree's install is about 700 MB.
