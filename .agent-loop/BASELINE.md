# Baseline on this machine (Windows 11, Node 26)

Everything in the verification list passes on current `origin/main`.

- If 4 tests under "loushy chat command" in `src/cli/chat.test.ts` fail with "readline was closed" (and `npm run test:coverage` then exits 1 so `npm run fallow` cannot read the coverage file): your branch predates the fix, PR #129, now on `origin/main`. Run `git fetch origin main && git merge origin/main` (never rebase) and re-run.
- Flaky while several agents share the machine (passes alone): `src/execution/guardrails.test.ts` "resolves to pass:false via the E9 timeout wrapper". Re-run that file alone; if coverage failed only because of it, re-run `npm run test:coverage`.
- After `npm run build`, `git status` can show `bin/loushy.js`, `packages/create-loushy-agent/bin/cli.js` and `src/cli/init/__snapshots__/templates.test.ts.snap` as modified with an empty diff (line endings). Never commit them: `git checkout -- <file>`.

Counts on main: vitest 2569 passed / 4 skipped (174 files), lint 0 errors / 400 warnings, 137 doc snippets, fallow 0 above threshold.
