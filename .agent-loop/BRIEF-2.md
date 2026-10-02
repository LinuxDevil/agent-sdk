# Round 2 brief: rules for every agent working a ticket

Read this before starting any round-2 ticket (GitHub issues labelled `round-2` in LinuxDevil/agent-sdk). It replaces BRIEF.md for round 2. The plan is [PLAN-2.md](PLAN-2.md); the evidence behind it is [AUDIT-2.md](AUDIT-2.md) and the three reports in [audit2/](audit2/).

## The project

`@lousho/build-ai-agent` (CLI `lousho`, scaffolder `create-lousho-agent`) is a TypeScript SDK for building AI agents. It was renamed from "loushy" on 2026-10-02; nothing in the tree says loushy any more except old branch names and `.agent-loop/` history. Version `1.0.0-alpha.8` is on npm. Docs: `docs/*.md` in this repository are the source of truth; the site at https://lousho.com is generated from them by the repository LinuxDevil/agent-sdk-docs (`scripts/sync-sdk-docs.mjs`), which also holds the Arabic translations.

## Owner's rules (do not break these)

1. Never delete a branch, local or remote.
2. Do not wait for CI. Verify locally, open the pull request, move on.
3. `README.md` stays the short front page; details go to `docs/`.
4. Never force-push `main`, rewrite history, publish to npm, or change release or publish configuration (`files`, `exports` removals, `publishConfig`, CI release steps) unless the ticket is labelled `owner-decision` and the issue records the owner's answer.
5. A breaking change before 1.0 needs a CHANGELOG entry with a migration note. Tickets labelled `breaking` say so.
6. One ticket is one pull request. Do not widen the scope; if you find something else, open a new issue and link it.

## How to work a ticket

1. Comment on the issue that you are starting (model and date), so two agents do not take the same ticket.
2. Work in your own git worktree created from the latest `origin/main`: `git -C E:/agent-sdk worktree add .claude/worktrees/<ticket-id> -b lou-<ticket-id>-<slug> origin/main`. Never work in `E:\agent-sdk` itself (the owner's checkout) or in another agent's worktree. Never run `git stash`, `git reset --hard` or `git checkout -- .` outside your own worktree.
3. `npm ci` in the worktree. Platform: Windows 11, Git Bash, Node 26 locally; CI runs Node 22 on Linux.
4. Line-ending noise: `bin/lousho.js`, `packages/create-lousho-agent/bin/cli.js` and `src/cli/init/__snapshots__/templates.test.ts.snap` may show as modified with no content change. Do not commit them; stage files by name.
5. Write tests first where the ticket adds behavior. Tests must run offline (see "Tests and live calls").
6. Update `docs/*.md` for anything user-visible, add a CHANGELOG entry under `## [Unreleased]`, run `npm run docs:llms`.
7. Do not rename, add or remove a `##` / `###` / `####` heading in an existing `docs/*.md` page unless the ticket says so: the Arabic pages are matched to the English ones by heading position. A new page is fine; mention it in the pull request so the docs site and its navigation get updated.
8. Commit with a message ending in `Co-Authored-By: <your model name> <noreply@anthropic.com>`. Push the branch, open the pull request with `gh pr create --base main`, body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and containing `Closes #<issue>`. Write the body to a file in the OS temp directory, not into the repository.
9. Merge with `gh pr merge <n> --squash --match-head-commit <sha>` only when every check below passed on the branch after syncing with the latest `origin/main`. If you were told not to merge, stop at the open pull request.

## Verification (run all, report real output in the pull request)

```bash
npx tsc --noEmit
npm run lint                      # zero warnings; warnings are errors
npm run build
npm run build --workspace=packages/create-lousho-agent
npm run test:types
npm run docs:verify-snippets -- --skip-build
npm run docs:llms:check
npm run test:coverage             # full suite; then:
npm run fallow
npm run typecheck --workspace apps/agent-forge
npm run typecheck:server --workspace apps/agent-forge
npm run test --workspace apps/agent-forge -- --run
npm run test:server --workspace apps/agent-forge
npm run pack-smoke                # for anything touching exports, bin, package.json or the build
```

Known local problems, not regressions: a native vitest crash on Node 26 / Windows (exit 127, no output) when two workers bundle at once; it leaves a build lock that makes the next run's `src/deploy` tests time out for up to 3 minutes. Re-run, or run `npx vitest run src/deploy` alone. `src/security/credentialBroker.test.ts` and `guardrails.test.ts` timeout tests are flaky under load. Agent Forge is not in CI, so its four checks are mandatory locally. If a failure exists on `origin/main` too, say so in the pull request with the evidence; do not fix it inside an unrelated ticket.

## Tests and live calls

- **Default: offline.** Use `mockModel` from `@lousho/build-ai-agent/testing`, or a `recordReplay` cassette. CI has no API key and must stay green without one.
- **Live calls are allowed only where the ticket has a "Live test" section**, and only through OpenRouter. The key is in `E:\agent-sdk\.claude\round2.env` (git-ignored) as `OPENROUTER_API_KEY`. Load it into the environment of the one command that needs it; do not export it in a shell profile.
- **Never print, log, commit or paste the key**: not in a pull request, an issue, a comment, a test snapshot, a cassette or a CHANGELOG. Before committing a recorded cassette, grep it for `sk-or-` and for `Authorization`. If you ever see the key in a tracked file or in output you are about to post, stop and tell the owner.
- **Budget: 10 USD for all of round 2**, enforced by a limit on the key itself. Unless the ticket says otherwise a ticket may spend at most **0.10 USD**. Use the cheapest model that can do the job: `openai/gpt-4o-mini` by default; a reasoning or vision model only when the ticket is about reasoning or images. Keep prompts short and `maxSteps` low. No loops over live calls, no load tests.
- **Measure spend with the key's own counter**, before and after your live calls:
  ```bash
  curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"
  ```
  The response has `data.usage` (USD spent so far) and `data.limit_remaining`. Put "Live test spend: before X, after Y" in the pull request. If `limit_remaining` is under 1.00, do not make live calls; report it.
- **Record once, replay forever.** When a live call proves something worth keeping, record it with `recordReplay` (or `lousho eval --record`) and commit the cassette so CI replays it for free.
- A live test in the repository must skip itself when `OPENROUTER_API_KEY` is not set (`it.skipIf(!process.env.OPENROUTER_API_KEY)`), and must not be in the default `npm test` path if it costs money on every run.
- The owner removes the key after each phase. A 401 means the phase is over: stop live testing and say so.

## Docker

Docker Desktop is installed on the owner's machine but the daemon is usually not running, and the sandbox's network egress and credential broker are refused on Docker Desktop by design (they need Docker Engine on Linux). Tests that need a real daemon belong in the Linux CI job that ticket M6 creates; locally they must skip when no daemon answers.

## Choosing a model

Issues carry `model:sonnet` or `model:opus`. Sonnet tickets are well specified: documentation, mechanical moves, additive features with a clear shape. Opus tickets touch the run loop, resume, approvals, security or public API design. A ticket labelled `hub` changes `AgentExecutor`, `resume`, tool-call execution or `createAgent`: only one hub ticket may be in progress at a time, and it must sync with `origin/main` right before merging.

## Reporting

End with: the pull request URL; each acceptance criterion with done / not done; what you could not verify and why; the verification output; live test spend. State failures plainly. Do not write "should work".
