# Baseline on this machine (Windows 11, Node 26)

Everything in the verification list passes on current `origin/main` (checked at a662bbe + #134/#135): vitest 2606 passed / 4 skipped (180 files), lint 0 errors / 345 warnings (do not exceed 345), 140 doc snippets, fallow 0 above threshold, Agent Forge typechecks and suites green.

- Flaky while several agents share the machine (each passes alone): `src/execution/guardrails.test.ts` "resolves to pass:false via the E9 timeout wrapper", `NodeWorkspace.test.ts` (env-leak / pid-file tests), `sandbox-wiring.test.ts`. Re-run the file alone; if `npm run test:coverage` failed only because of one of these, re-run it (fallow needs the coverage file it writes).
- After `npm run build`, `git status` can show `bin/loushy.js`, `packages/create-loushy-agent/bin/cli.js` and `src/cli/init/__snapshots__/templates.test.ts.snap` as modified with an empty diff (line endings). Never commit them: `git checkout -- <file>`.
- Agent Forge (`apps/agent-forge`) resolves the SDK from the root `dist/`: if you change public types Forge uses (spec, events, messages, stores), run `npm run build` then `npm run typecheck --workspace apps/agent-forge` and `npm run typecheck:server --workspace apps/agent-forge` too.
- Before your final verification: `git fetch origin main && git merge origin/main` (never rebase), so the PR is verified against current main.
