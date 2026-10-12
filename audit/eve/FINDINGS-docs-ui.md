# Eve audit: docs, examples & Agent Forge studio UI

- **Tarball:** `1.0.0-alpha.19`.
- **Repros and screenshots:** `audit/eve/docs-ui/`. `docs-a/` and `docs-b/` hold the doc repros, `examples/` holds the run logs, the `studio-*.cjs` scripts are Playwright, and `shots/` holds the screenshots.
- **How it was tested:** about 33 live gpt-4o-mini calls. The studio ran via `lousho studio --port 4751`.

## Summary
- **The studio API has no auth and sends `Access-Control-Allow-Origin: *`.** It stores provider keys, starts runs and executes hook code.
- **The studio keeps its agent list in `localStorage`, not in `.lousho/agents/`.** Agents leak across projects, agents on disk never appear in the list, and chat fails on new agents.
- **Robustness is weak.**
  - An agent name containing a space blanks the app.
  - A bad YAML import fails silently.
  - Ctrl+D inside a text field duplicates a node.
  - Below 860 px the studio is unusable.
- **The studio falls back to the mock provider silently** when the API key is missing.
- **The docs drift from runtime behaviour.**
  - Durable tools see `ctx.sessionId = "<id>.turn-<n>"`.
  - `nextjs.md` documents an `approvers` option that does not exist.
  - The optional-peer error contract is broken on `send()`.
- **The flagship `ops-pipeline` example can't be completed as documented.** The examples are never type-checked, and the starter examples only print canned strings.

## Findings

### DUI-F1: Studio API is unauthenticated with wildcard CORS, yet stores keys, starts runs and runs hook code
**Severity** high · **Lens** SWE · **Type** security
**Evidence** — `curl -H "Origin: https://example.com" /health` returns `Access-Control-Allow-Origin: *`. No route checks auth. The exposed routes include `PUT /settings/providers/:p`, `POST /agents/:id/run` (which accepts a full spec) and the deploy-adapter routes. Hook code runs in a child `node` process.
**Root cause** — `apps/agent-forge/server/app.ts:579` (`app.use(cors())`); there is no auth middleware.
**Suggested fix** — Drop `cors()`. Enforce the Origin/Host header. Mint a per-launch token, include it in the printed URL, and require it on every API and WebSocket call.

### DUI-F2: The studio agent list lives in `localStorage`, ignores `.lousho/agents/`, and leaks across projects
**Severity** high · **Lens** PM / SWE · **Type** bug / docs
**Evidence** — `studio-leak.cjs`. Contradicts `docs/agent-forge.md:48-51`.
**Root cause** — `apps/agent-forge/src/state/AppState.tsx:142` (`LocalStorageAgentStore`); `src/persistence/AgentStore.ts:10-24`.
**Suggested fix** — Add an `HttpAgentStore` backed by `GET/PUT /agents`.

### DUI-F3: An agent name with a space or `!` blanks the whole studio
**Severity** high · **Lens** Design / SWE · **Type** bug
**Evidence** — `studio-badname2.cjs` throws `TypeError: n.filter is not a function`. The bad agent survives a reload as a ghost.
**Root cause** — `apps/agent-forge/src/runtime/runtimeClient.ts:106-154` doesn't check `res.ok`. There is no error boundary, and `LeftRail.tsx:120-127` doesn't validate the name (the server's rule is at `server/types.ts:19`).
**Suggested fix** — Validate the name inline, throw on `!res.ok`, and add an error boundary.

### DUI-F4: With no API key, the studio silently runs the mock provider
**Severity** high · **Lens** AI eng / Design · **Type** bug / UX
**Evidence** — `studio-flow3.cjs`: the reply is "This is a mock response." The only signal is a log line.
**Root cause** — `apps/agent-forge/server/runRegistry.ts:465-474`; `src/components/Topbar.tsx:69-75`.
**Suggested fix** — Fail with an actionable error, or show a persistent MOCK banner. The env pill should reflect the provider that actually ran.

### DUI-F5: With a durable store, tools, `needsApproval` and permission rules receive `ctx.sessionId = "<id>.turn-<n>"`
**Severity** high · **Lens** SWE / AI eng · **Type** bug / docs
**Evidence** — `docs-a/sess-sessionid-ctx.ts`: plain mode passes `user-42`; durable mode passes `user-42.turn-0`.
**Root cause** — `src/session/AgentSession.ts:759`; `src/execution/toolCallExecution.ts:110,327,603`.
**Suggested fix** — Carry `checkpointId` separately and pass the real session id to tool contexts.

### DUI-F6: The flagship `ops-pipeline` example can't be completed, and its setup clobbers the root `.env`
**Severity** high · **Lens** PM / Design · **Type** bug / docs
**Evidence** — The demo binds random ports, so the documented trigger gets `ECONNREFUSED 8787`. The README's `cp .env.example .env` overwrites the root `.env`. None of the variables in `.env.example` are read, and `SLACK_SIGNING_SECRET` is missing from it.
**Root cause** — `examples/ops-pipeline/monitor.ts:166`, `index.ts:284,306`, README step 2.
**Suggested fix** — Default the ports to 8787/8788 via env, fix the README, trim `.env.example`, log the PR, and add a smoke test.

### DUI-F7: Chat on a newly created studio agent fails until you press Run
**Severity** medium · **Lens** Design / PM · **Type** bug
**Root cause** — `useAgentDocument.ts:137-150`, `runRegistry.ts:455-458`, `runtimeClient.ts:131-136`.
**Suggested fix** — Fixed by DUI-F2, or send the spec with the message.

### DUI-F8: The studio is unusable below 860 px
**Severity** medium · **Lens** Design · **Type** UX
**Evidence** — `shots/home-tablet.png`, `home-mobile.png`.
**Root cause** — `apps/agent-forge/src/components/layout.css:893-901`.
**Suggested fix** — Use drawers below the breakpoint and an overflow menu, or show an explicit "needs ≥900px" notice.

### DUI-F9: Keyboard and screen-reader gaps; colours fail contrast
**Severity** medium · **Lens** Design · **Type** a11y
- **Keyboard**
  - Palette items are drag-only.
  - The hook switch, hook chips and break toggle don't respond to Enter or Space.
- **Screen reader**
  - Tabs have no tab roles.
  - The Provider select, model input, chat textarea and history select are unlabeled.
  - The page has no landmarks or headings.
  - Status has no `aria-live` region.
- **Contrast** fails at 2.77–3.92:1 on the pills, the Run button and muted text.
**Root cause** — `Inspector.tsx:33-62,283-316`, `Topbar.tsx:38-44`.
**Suggested fix** — Each item above is about one point.

### DUI-F10: Ctrl/Cmd+D duplicates a node while typing in a text field
**Severity** medium · **Lens** Design · **Type** bug
**Root cause** — `apps/agent-forge/src/components/CanvasArea.tsx:271-282`.
**Suggested fix** — Ignore the shortcut when the target is editable, and scope it to the canvas.

### DUI-F11: Importing an invalid YAML or spec fails silently
**Severity** medium · **Lens** Design · **Type** bug / UX
**Root cause** — `Topbar.tsx:96-103` has no try/catch.
**Suggested fix** — Route the import through `attempt()` and show the error in a banner.

### DUI-F12: `nextjs.md` documents an `approvers` option and a no-self-approval default that don't exist
**Severity** medium · **Lens** SWE / Design · **Type** docs (security)
**Evidence** — `docs-b/nextjs-approvals.ts`: alice can approve her own call.
**Root cause** — `src/server/routeHandler.ts:21`, `fetchRoutes.ts:105-107`.
**Suggested fix** — Rewrite `docs/nextjs.md:70-72` around `authorizeApproval`.

### DUI-F13: A non-object `output` root is accepted, then rejected by the provider with a 400
**Severity** medium · **Lens** AI eng / Design · **Type** bug
**Evidence** — `docs-b/structured-rootarray.ts`.
**Root cause** — `src/execution/structuredOutput.ts:260`.
**Suggested fix** — Throw `ConfigurationError` when the root `type` is not `object`, with a hint to wrap it.

### DUI-F14: The optional-peer error contract is broken on `send()` and `/otel`
**Severity** medium · **Lens** Design / SWE · **Type** bug / docs
**Evidence** — `docs-a/iso-send-missing-peer.mts`, `iso-otel-missing-peer.mts`.
**Root cause** — `src/execution/generateStep.ts:322-331`, `src/execution/otel.ts:38`.
**Suggested fix** — Rethrow `MissingPeerDependencyError` unchanged, lazy-load OTel, and fix the doctor peer list.

### DUI-F15: `approvals.get/list` stay stale after another process resolves the approval
**Severity** medium · **Lens** SWE · **Type** bug
**Evidence** — `docs-a/appr-crossproc.ts`.
**Root cause** — `src/createAgentApprovals.ts:415-418`.
**Suggested fix** — Check the store first in `get()`, and filter `list()` against the store.

### DUI-F16: Examples are never type-checked; strict `tsc` reports 10 errors
**Severity** medium · **Lens** SWE · **Type** DX
**Suggested fix** — Add `tsconfig.examples.json`, a CI step, and fix the errors.

### DUI-F17: Five starter examples print only a canned mock string
**Severity** medium · **Lens** PM / AI eng · **Type** DX
**Suggested fix** — Use a scripted provider plus a `LIVE_MODEL` switch, and move `workflow-router` to `output: z.enum`.

### DUI-F18: TypeDoc covers only the root entry and isn't published; 1,271 exports are undocumented
**Severity** medium · **Lens** PM / Design · **Type** docs
**Suggested fix** — Add every exports entry to `entryPoints`, publish the output, and ratchet the undocumented count in CI.

### DUI-F19: Docs snippets outside quick-start use undefined names; the CI checker has blind spots
**Severity** low-med · **Lens** Design · **Type** docs
**Root cause** — `scripts/verify-docs-snippets.ts:57-75`.
**Suggested fix** — Define the placeholders on each page, execute the mock-backed snippets, and handle `tsx` fences.

### DUI-F20: llms.txt has truncated descriptions, internal ticket ids, Deployment under "Optional", and GitHub HTML links
**Severity** low · **Lens** AI eng / Design · **Type** docs
**Root cause** — `scripts/llmsTxt.ts`.

### DUI-F21: Studio status, copy and naming contradict the docs
**Severity** low · **Lens** Design · **Type** UX / docs
- A successful run shows `STOPPED`.
- Run injects a fake user message.
- The typed name is ignored.
- There is no rename or delete.
- There is no "server down" state.
- The UNSAVED badge is green.
- The secrets-key caveat is undocumented.

### DUI-F22: The Output node is double-boxed and the minimap is always empty
**Severity** low · **Lens** Design · **Type** visual
**Root cause** — The `output` node type collides with React Flow's built-in type (`AgentNode.tsx:197`). `MiniMap` gets no `nodeColor`.

### DUI-F23: Smaller doc-vs-behaviour drifts
**Severity** low · **Type** docs
- Expired approval has no `reason`.
- `fork().messages` is empty.
- `send({sessionId})` requires a store.
- The handoff warning timing is wrong.
- The fallback event names providers, not models.
- The invalid-session hint is wrong.
- `GET /chat/:id` returns 0 messages while paused.
- The `node-server` pin uses `^`.
- Built-in providers skip the AI SDK version-pair check.

### DUI-F24: Smaller example defects
**Severity** low · **Type** DX
- The openrouter example uses costly defaults and a hard-coded capabilities list.
- The hostinger-deploy example puts secrets on the ssh argv.
- The tracing example has no README.
- There is a spurious registry warning.
- deep-research produces duplicate bullets.

## Verified non-issues
- 105 snippets type-check, apart from placeholders.
- Quick-start runs live.
- These areas hold up: streaming, testing, structured output, handoffs, providers, approvals, memory, sessions, tools/SSRF, and Next.js/deploy.
- `docs:llms:check` passes.
- The examples' vitest suite passes.
- 19 of 20 examples run offline.
- The studio's happy path works, and the server validates agent ids.
