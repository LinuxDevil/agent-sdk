# Shared brief for agent-sdk sub-ticket work

Repo: @loushy/build-ai-agent (TypeScript AI agent SDK), GitHub LinuxDevil/agent-sdk, default branch `main`.
You are working in your own git worktree (run `pwd` and `git worktree list` to confirm). The main checkout at /home/user/agent-sdk is being used by other agents: NEVER edit files there and never check out branches there.

## Setup (do this first)
1. `git fetch origin main` then create your branch from `origin/main`: `git checkout -b <branch> origin/main` (branch name given in your task).
2. `npm ci --no-audit --no-fund` inside your worktree (npm cache is warm, takes ~1 min). node_modules is gitignored.
3. Read CONTRIBUTING.md, CHANGELOG.md, docs/api-overview.md, and the source files named in your task before changing anything. Read docs/plan/tickets.md for the ticket catalogue and docs/research/feature-audit.md for background.

## Conventions
- Tests live next to source as `*.test.ts` (vitest). Deterministic agent tests use `mockModel` from `src/testing` (see src/testing/mockModel.ts and existing tests such as src/execution/durableExecution.test.ts or src/subagents/subagents.test.ts for patterns).
- No `any` in new code (eslint warns; warning count must not grow). No new runtime dependencies without a strong reason.
- Public API changes: export from the right `src/**/index.ts` and, if user-facing, the root `src/index.ts`. Breaking changes get a CHANGELOG.md entry under [Unreleased] with a migration note.
- Docs: README.md and docs/*.md ```ts blocks are type-checked in CI (`npm run docs:verify-snippets -- --skip-build`, needs `npm run build` first). `llms.txt`/`llms-full.txt` are generated from README + docs: if you touch any .md under docs/ or README.md, run `npm run docs:llms` and commit the regenerated files.
- Keep the diff focused: roughly <= 200 lines of non-test, non-doc, non-generated change. If the ticket is bigger than that, STOP, do not ship a big PR; report a proposed split instead.
- Do not modify files outside your ticket's scope unless the build forces it; say so in your report if you did.

## Verification (all must pass before you push)
```
npx tsc --noEmit
npm run lint              # 0 errors; warning count must not exceed main's
npm run test:types
npx vitest run            # full suite
npm run build && npm run build --workspace=packages/create-loushy-agent
npm run docs:verify-snippets -- --skip-build   # if you touched README/docs or public types used by snippets
npm run docs:llms:check   # if you touched README/docs
npm run test:coverage && npm run fallow        # fallow = dead-code/duplication gate; must report no issues
```
If an unrelated test is flaky, re-run it in isolation once and mention it in your report. Never skip or disable a test.

## Commit and PR
- Commit with a clear message. End every commit message with exactly these two lines:
```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016bY29ibQgv3MDdjAbUT4YR
```
- Push: `git push -u origin <branch>` (retry up to 4 times with 2s/4s/8s/16s backoff on network errors).
- There is no `gh` CLI. Open the PR with the GitHub MCP tool: first `ToolSearch` with query `select:mcp__github__create_pull_request`, then call it with owner `LinuxDevil`, repo `agent-sdk`, base `main`.
- PR title format: `[EPIC-<letter>][LOU-<id>] <imperative summary>` e.g. `[EPIC-U][LOU-U17] Sandboxed HTTP honors cancellation`.
- PR body sections: `## What`, `## Why`, `## Acceptance criteria` (checklist, all ticked), `## How verified` (the exact commands and their result lines). End the body with:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_016bY29ibQgv3MDdjAbUT4YR
```
- Do NOT merge the PR. Do not force-push. Do not touch release/publish config or package versions.

## Final report (your last message)
Return: branch name, PR URL, head SHA, a 3-line summary of the change, the verification command results (pass/fail with counts), any files touched outside scope, and anything you deliberately left out.

## Branches
Never delete any branch, local-remote or remote, merged or not (owner instruction).

## Runtime constraint
Nothing under src/execution, src/providers, src/context, src/tools (except node-only workspace/sandbox modules that are already Node-specific) may import `node:*` modules: the Cloudflare Worker bundle (src/deploy/runtime.worker.ts) includes them and the cloudflare adapter test (`wrangler dev`) fails. Use `globalThis.crypto`, `newId()` from src/utils/id.ts, etc.
