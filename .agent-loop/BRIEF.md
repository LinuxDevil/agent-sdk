# Shared brief for agent-sdk sub-ticket work

Repo: @loushy/build-ai-agent (TypeScript AI agent SDK), GitHub LinuxDevil/agent-sdk, default branch `main`.
You are working in your own git worktree (run `pwd` and `git worktree list` to confirm). The main checkout at `E:\agent-sdk` and the other worktrees under `E:\agent-sdk\.claude\worktrees\` belong to the owner and other agents: NEVER edit files there and never check out branches there.

## Machine
Windows 11, Node 26, npm 11, `gh` CLI logged in as the repo owner. The Bash tool is Git Bash (POSIX syntax, `/e/agent-sdk/...` paths); PowerShell is also available. `core.autocrlf` is `true` on this machine: before every commit run `git status --short` and `git diff --stat` and make sure only files you meant to change are listed. Never commit a line-ending-only change (if a file shows as modified with no real diff, `git checkout -- <file>`).

The loop ran on Linux until now, so a few tests may fail on Windows for reasons that have nothing to do with your ticket (path separators, CRLF snapshots, `wrangler dev`/workerd, shell tools, Docker). If a test you did not touch fails, check whether it also fails on unmodified `origin/main`. First look for `BASELINE.md` next to this brief (the orchestrator writes the list of tests failing on main on Windows there once its baseline run finishes). If the file is not there yet or the test is not listed: commit your work as a WIP commit, `git checkout --detach origin/main`, re-run that one test file, then `git checkout <branch>`. Never use `git stash`: the stash stack is shared across all worktrees and agents. If the test fails on main too, do not fix it and do not skip it: list it in your report as "fails on main on Windows". Only failures your change introduces block the PR.

## Setup (do this first)
1. `git fetch origin main` then create your branch from `origin/main`: `git checkout -b <branch> origin/main` (branch name given in your task).
2. `npm ci --no-audit --no-fund` inside your worktree. node_modules is gitignored.
3. Read CONTRIBUTING.md, CHANGELOG.md, docs/api-overview.md, and the source files named in your task before changing anything. `docs/plan/tickets.md` is the ticket catalogue.

## Conventions
- Tests live next to source as `*.test.ts` (vitest). Deterministic agent tests use `mockModel` from `src/testing` (see src/testing/mockModel.ts and existing tests such as src/execution/durableExecution.test.ts or src/subagents/subagents.test.ts for patterns).
- No `any` in new code (eslint warns; lint fails on any warning since D16). No new runtime dependencies unless your task says so.
- Public API changes: export from the right `src/**/index.ts` and, if user-facing, the root `src/index.ts`. Breaking changes get a CHANGELOG.md entry under [Unreleased] with a migration note. New features get a CHANGELOG entry too.
- Docs: README.md stays the short front page; details go under docs/. README.md and docs/*.md ```ts blocks are type-checked in CI (`npm run docs:verify-snippets -- --skip-build`, needs `npm run build` first). `llms.txt`/`llms-full.txt` are generated from README + docs: if you touch any .md under docs/ or README.md, run `npm run docs:llms` and commit the regenerated files.
- Keep the diff focused: roughly <= 200 lines of non-test, non-doc, non-generated change. If the ticket is bigger than that, STOP, do not ship a big PR; report a proposed split instead.
- Do not modify files outside your ticket's scope unless the build forces it; say so in your report if you did.
- Dependency changes (only if your task allows them): `npx npm@11 install`, never npm 10 (it strips `libc` fields from the lockfile).

## Runtime constraint
Nothing under src/execution, src/providers, src/context, src/tools, src/server (except node-only workspace/sandbox modules that are already Node-specific) may import `node:*` modules: the Cloudflare Worker bundle (src/deploy/runtime.worker.ts) includes them and the cloudflare adapter test (`wrangler dev`) fails. Use `globalThis.crypto`, `fetch`, `newId()` from src/utils/id.ts, etc.

## Verification (all must pass before you push, apart from failures proven to exist on main on Windows)
```
npx tsc --noEmit
npm run lint              # must exit 0: zero warnings, enforced
npm run test:types
npm run build && npm run build --workspace=packages/create-loushy-agent
npx vitest run            # full suite, after the builds
npm run docs:verify-snippets -- --skip-build
npm run docs:llms:check
npm run test:coverage && npm run fallow        # fallow = dead-code/duplication/complexity gate; must exit 0
npm run typecheck --workspace apps/agent-forge && npm run typecheck:server --workspace apps/agent-forge   # after npm run build; Forge compiles the SDK source and is NOT in CI, so this is the only check
```
Fallow fails on unused exports and on complex functions, so keep functions small and export only what is used or public. Known flaky under load (pass alone): `src/execution/guardrails.test.ts` child-process timeout test, `NodeWorkspace.test.ts` pid-file test. If a test is flaky, re-run it in isolation once and mention it in your report. Never skip or disable a test.

## Commit and PR
- Commit with a clear message ending with a `Co-Authored-By:` line naming the model you are, for example `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Push: `git push -u origin <branch>` (retry up to 4 times with backoff on network errors). Never force-push.
- Open the PR with `gh pr create --repo LinuxDevil/agent-sdk --base main --head <branch> --title "<title>" --body-file <file>` (write the body to a file in your worktree's parent temp location or pass it by heredoc; do not commit it).
- PR title format: `[EPIC-<letter>][LOU-<id>] <imperative summary>` e.g. `[EPIC-U][LOU-U17] Sandboxed HTTP honors cancellation`.
- PR body sections: `## What`, `## Why`, `## Acceptance criteria` (checklist, all ticked), `## How verified` (the exact commands and their result lines). End the body with:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
- Do NOT merge the PR. Do not touch release/publish config or package versions. Never publish to npm.

## Branches
Never delete any branch, local or remote, merged or not (owner instruction).

## Final report (your last message)
Return: branch name, PR URL, head SHA, a 3-line summary of the change, the verification command results (pass/fail with counts), tests that fail on main on Windows (if any), any files touched outside scope, and anything you deliberately left out.
