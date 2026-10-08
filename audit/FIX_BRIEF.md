# Fix brief: audit 2026-10-08

You are fixing verified findings from a real-world audit of the Lousho SDK
(`E:\agent-sdk`, GitHub `LinuxDevil/agent-sdk`). The plan is
`E:\agent-sdk\audit\PLAN.md`, and the evidence for each finding is in
`E:\agent-sdk\audit\<project>\FINDINGS*.md` (with repro scripts next to it).
**The owner wants autonomous work: no check-ins. Open the PR and squash-merge it
immediately; do not wait for CI.** Publishing to npm is the owner's job; never publish.

## Workflow for each work item (one PR per item)

1. **Create a fresh worktree from the latest main.** Do not touch `E:\agent-sdk` itself;
   another session works there.
   ```bash
   cd /e/agent-sdk && git fetch origin main -q
   git worktree add -b fix/audit-<id>-<slug> /c/lousho-wt/audit-<id> origin/main
   cd /c/lousho-wt/audit-<id> && npm ci --no-audit --no-fund
   ```
2. **Confirm the root cause in the current source.** Cited line numbers may be off.
   If the finding turns out to be wrong, or already fixed, write that down and skip it.
3. **Test first.** Add a failing test that reproduces the bug (vitest, colocated
   `*.test.ts`; follow neighbouring test style), then make the minimal, root-cause fix.
   Match the surrounding code's style and comment density. Do not refactor beyond the fix.
4. **Docs and changelog.** Update the relevant `docs/*.md` if behaviour or options change.
   Add a concise entry under `## [Unreleased]` in `CHANGELOG.md`, under the right
   `### Added` / `### Fixed` / `### Changed` heading. Write it user-facing and say what
   changed for the user.
5. **Gates.** All of these must pass:
   - `npx tsc --noEmit`
   - `npm run typecheck:tests`
   - `npm run lint`
   - `npx vitest run <touched areas>`, then the full `npx vitest run`. Note
     pre-existing failures by checking them on a clean `origin/main` worktree; don't
     fix unrelated ones.
   - If the public API changed: `npm run api:update`, and commit the report.
   - If docs changed: `npm run docs:llms` and `npm run docs:verify-snippets -- --skip-build`.
   - If `registry/` changed: run its build/check scripts (`npm run registry:check`;
     see `package.json`).
6. **Commit.** Use a conventional commit, e.g. `fix(server): ...`. End the message with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
7. **Open the PR and merge it:**
   ```bash
   git fetch origin main && git rebase origin/main   # resolve CHANGELOG conflicts by keeping both entries
   git push -u origin HEAD
   gh pr create --base main --title "<conventional title>" --body "<what/why, link audit finding ids, test evidence>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)"
   gh pr merge --squash --admin --delete-branch   # repo ruleset blocks until checks pass; owner wants immediate merge, so use --admin
   ```
   If the merge fails because main moved, rebase again, re-run the touched tests, push
   with `--force-with-lease`, and retry the merge.
8. **Clean up.** Remove your worktree after merging:
   `git -C /e/agent-sdk worktree remove /c/lousho-wt/audit-<id> --force`.

## Rules

- Never print or commit secrets. Do not call real external services in tests.
- If an item needs a design decision, pick the conservative, backwards-compatible option
  and record it in the PR body.
- **Final reply:** for each item, give the PR URL, merged yes/no, what changed, the
  tests added, and anything skipped and why.
- Disk is tight: SDK tests leak `%TEMP%/lousho-*` dirs (tens of thousands). After your full vitest run,
  delete ones older than 30 min: `find /c/Users/recti/AppData/Local/Temp -maxdepth 1 -name 'lousho-*' -mmin +30 -exec rm -rf {} +`.
  Run full suites with `--maxWorkers=4` — many agents share this machine.
