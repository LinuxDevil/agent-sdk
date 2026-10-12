# Eve fix brief (for fix agents)

You are fixing one ticket from `E:\agent-sdk\audit\eve\PLAN.md`. The findings it
cites are in `E:\agent-sdk\audit\eve\FINDINGS-*.md`. Each finding has evidence,
a repro under `audit/eve/<area>/`, a root cause with `src/...:line`, and a
suggested fix. Read the cited finding(s) first.

**Work in your own git worktree.** You are given one, or you create one under
`E:\agent-sdk-wt\eve-<ticket>` from `origin/main`. `audit/` is untracked in the
main checkout, so read the findings and repros through the absolute path
`E:\agent-sdk\audit\eve\...`. Do not edit anything in `E:\agent-sdk` (the main
checkout) itself.

## Steps
1. `git fetch origin && git switch -c fix/eve-<ticket>-<slug> origin/main`. If the worktree has no `node_modules`, run `npm ci`.
2. Write a failing regression test next to the code (vitest, `*.test.ts`). Run it and see it fail for the reason the finding describes.
3. Implement the minimal fix the finding suggests. Match the surrounding code style. Use coded errors (`LOUSHO_*`) consistent with `src/execution/errors.ts`. Where behaviour changes, update the matching docs in `docs/`. Don't widen scope beyond the ticket.
4. Verify:
   - `npx tsc --noEmit -p tsconfig.json`
   - `npm run lint`
   - `npx vitest run <touched dirs>`
   - If the public API changed: `npm run build && npm run api:update`, then commit the `api/` report diff.
5. Add one line to `CHANGELOG.md` under the unreleased/top section, citing the finding id (e.g. "(Eve TOOLS-F1)").
6. Commit with a conventional message (`fix(<area>): ... (Eve <ID>)`). End the message with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
7. Push and open the PR: `gh pr create --base main --title ... --body ...`. The body explains the finding, the fix and the test. End the body with:
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
8. Merge, following the owner's standing workflow (don't wait for CI):
   1. `git fetch origin && git rebase origin/main`.
   2. Resolve conflicts. `CHANGELOG.md`: keep both lines. `api/*` reports: regenerate.
   3. Re-run the touched tests, then `git push --force-with-lease`.
   4. `gh pr merge <n> --squash --admin --delete-branch`.
   5. If the merge fails because main moved, repeat from step 1 of this list.
9. Final reply: PR URL, merged yes/no, a one-line summary, and anything left undone.

Never print secrets (`E:\agent-sdk\.env`). Never publish to npm.
