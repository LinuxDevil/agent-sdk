# Baseline on this machine (Windows 11, Node 26)

Everything in the verification list passes on `origin/main` at 332385c (the end of the loop): lint 0 errors / 0 warnings (lint fails on any warning), vitest 2955 passed / 4 skipped, 171 doc snippets, fallow 0 above threshold, Agent Forge typechecks and suites green.

- Flaky while several agents share the machine (each passes alone): `src/execution/guardrails.test.ts` E9 timeout test (EPERM on temp-dir cleanup), `NodeWorkspace.test.ts`, `sandbox-wiring.test.ts`, `src/security/credentialBroker.test.ts` end-to-end, `src/tools/built-in/http.test.ts` validateSSL, `src/tools/mcp/connect.test.ts`.
- Native vitest crash (shown by Git Bash as exit 127 or 139, no test summary): Node 26 on Windows crashes when two vitest workers bundle with esbuild at once. The deploy tests take a lock (`src/deploy/buildLock.testkit.ts`); a coverage run can still hit it. Re-run.
- After `npm run build`, `git status` can show `bin/loushy.js`, `packages/create-loushy-agent/bin/cli.js` and `src/cli/init/__snapshots__/templates.test.ts.snap` as modified with an empty diff (line endings). Never commit them: `git checkout -- <file>`.
- Agent Forge resolves the SDK from the root `dist/` and is not in CI: run `npm run build`, then both Forge typechecks, for every change.
- Before the final verification of a branch: `git fetch origin main && git merge origin/main` (never rebase).
