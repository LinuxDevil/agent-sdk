# Harness validation report — Lousho × Pi (H1, H2, H3)

Branch: `integration/harnesses` (merges `harness-h1-native-kit` `7aaac1a6`,
`harness-h2-pi-provider` `4ea5259a`, `harness-h3-pi-coder` `ee4b55df`, plus
integration fix `72d6ccd6`). Base: `main` at the coding-harness baseline
(`6414557e`).

Pinned packages: `@earendil-works/pi-ai@1.0.3`, `@earendil-works/pi-coding-agent@1.0.2`
— both optional peer dependencies **and** devDependencies at *exact* versions,
per the brief ("keep exact Pi versions and test every upgrade"). Trade-off to
note: an exact peer means consumers must install precisely `1.0.3` / `1.0.2`;
if that proves too tight for users, widen to `^` deliberately, with a test run.

Live model everywhere: `openrouter/openai/gpt-4o-mini` (spec form
`pi/openrouter/openai/gpt-4o-mini` for the pi provider). **No substitution was
needed**: pi-ai's catalog contains `openai/gpt-4o-mini` under its `openrouter`
provider, the exact model the brief asked for. Every live call carries
`limits: { maxCostUsd: 0.05 }`.

## Offline results — all green

Full suite after integration: **305 test files / 4435 tests passed, 10 skipped**
(live-gated), 0 failures. `typecheck`, `lint`, `build`, `registry:check`,
`api:check` all pass.

| Harness | Offline evidence |
|---|---|
| **H1 native-kit** (Phase 3) | `examples/coding-harness/kit.test.ts` — `lousho add coding-kit` installs the directory + records `lousho-registry.json`; `loadAgentDir` runs the scripted scenario (fixes `math.js`, `math.test.js` untouched, `rm` denied + audited, checkpoints, loop-guard hook, explorer sub-agent delegation); `lousho build --target=node-server` produces a deployment whose `POST /chat` answers the same task. `src/agentDir/loadAgentDir.test.ts` — 24 tests covering the new `agent.*` keys (`permissionMode`, `permissions`, `compaction`, `hooks`, `approve`, `limits`), `instructions/<family>.md` selection, unknown-key rejection, worker-target rejection of file-path hooks/approve. |
| **H2 pi-provider** (Phase 1) | `src/providers/pi/piProvider.test.ts` — 16 faux-backend tests: message/image/file/tool-call/tool-result mapping, zod→JSON Schema conversion, stream chunk mapping (`text-delta`, `tool-call`, `reasoning-delta`, `finish`), usage incl. cached/reasoning tokens, pi retries pinned off so `retry`/`fallbackModels` remain the only retry layer. `resolveProvider`/`builtinProviders`/`importGraph`/`missingPeer` tests cover the `pi/...` spec routing, the optional-peer error (`npm install @earendil-works/pi-ai@1.0.3`) and the worker-bundle shim (pi is Node-only; `cloudflare-worker` refuses `pi` specs). |
| **H3 pi-coder** (Phase 2) | `src/subagents/piAgent.test.ts` — 9 tests: `piAgent()` over `createAgentSession` fixes the fixture with the `faux` provider; `deny` produces `tool.error`; `ask` emits `approval.requested` → `SubagentApprovalPause` (durable across restart via the task's `sessionId`) → resume lets exactly that one call through (Pi has no run-blocked-call API; the model re-issues it and the gate allows it once); rejection sends the note as the next turn; usage aggregates into the lead's `result.usage`; `remoteAgent.test.ts` covers `defineRemoteSubagent()`. `SubagentApprovalPause` and `defineRemoteSubagent` are now public exports. |

## Live results — not run (no key)

`OPENROUTER_API_KEY` was not set in the environment, so all live suites
correctly skipped (each uses `it.skipIf`/`describe.skipIf` on the env var).
Nothing about live behavior is verified yet; costs incurred: **$0.00**.

To run the live pass (budget: each run ≤ $0.05, all three ≪ $0.30 total):

```bash
OPENROUTER_API_KEY=<key> npx vitest run examples/coding-harness src/providers/pi src/subagents/piAgent.test.ts
```

| Live test | Model used |
|---|---|
| `kit.test.ts` — kit fixes `math.js`, `node --test` passes, test file untouched, `rm` denied in audit | `openrouter/openai/gpt-4o-mini` |
| `piProvider.live.test.ts` — streaming + tool use + reasoning/usage parity vs `openrouter/` provider | `pi/openrouter/openai/gpt-4o-mini` |
| `piAgent.test.ts` — `run()` and `stream()` on the same coding task | `openrouter/openai/gpt-4o-mini` via pi-coding-agent |

## Integration fixes applied on top of the three branches

- Exact peer pins (`1.0.3`, `1.0.2`) in `peerDependencies`, `peerDependenciesMeta`,
  devDependencies, `PI_PEER.range`/`accepts`, `FEATURE_PEERS` install hint, docs.
- `providerSpec`: `envForInfoOnly` now surfaces on `ProviderInfo`; `lousho init`
  no longer emits Ollama's "base URL" hint for pi, and pi scaffolds on `ai` 7.
- `lousho doctor`: pi-ai was reported twice (provider-peer + feature-peer maps,
  same check id) — deduped; pi's env check no longer claims a non-existent
  "provider default endpoint".
- `examples/README.md` indexes `coding-harness`.
- Build heap raised `6144 → 8192`: the merged DTS graph OOMs tsup's worker at 6 GB
  (verified locally; CI workflows still pin `NODE_OPTIONS=--max-old-space-size=6144`
  and may need the same bump if the runner OOMs).

## Known limitations & open questions

- **pi is Node-only.** `lousho build --target=cloudflare-worker` refuses `pi/...`
  specs (worker shim explains why). Workers support is a future decision.
- **Approval replay is re-issue based.** Pi cannot run a previously blocked tool
  call, so on approval the adapter asks the model to repeat the call and lets
  that exact call through once. Prototype validated; watch for models that
  re-issue with different args (the gate won't match and the run will re-pause).
- **`npm run build -- --dts-only`** loses `dist/deploy/worker.d.ts` (tsup ignores
  `dts.entry` in dts-only mode). Only affects partial builds; full `npm run build`
  is correct.
- **Abort propagation** in `piAgent` is implemented but has no dedicated test yet.
- Brief follow-ups not in this validation: Agent Forge editing the new `agent.*`
  fields end-to-end, `lousho export --to pi`, `.pi/skills/<name>/SKILL.md`
  generator fix, `spec` subpath export, the `coding-pi` / `research` base kits,
  public-vs-private registry kits, Pi TUI vs ACP-only.
