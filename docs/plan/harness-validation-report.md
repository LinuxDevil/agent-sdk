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

Full suite after integration + the production-harness work: **306 test files /
4443 tests passed, 11 skipped** (live-gated), 0 failures. `typecheck`, `lint`,
`build`, `registry:check`, `api:check` all pass.

| Harness | Offline evidence |
|---|---|
| **H1 native-kit** (Phase 3) | `examples/coding-harness/kit.test.ts` — `lousho add coding-kit` installs the directory + records `lousho-registry.json`; `loadAgentDir` runs the scripted scenario (fixes `math.js`, `math.test.js` untouched, `rm` denied + audited, checkpoints, loop-guard hook, explorer sub-agent delegation); `lousho build --target=node-server` produces a deployment whose `POST /chat` answers the same task. `src/agentDir/loadAgentDir.test.ts` — tests covering the new `agent.*` keys (`permissionMode`, `permissions`, `compaction`, `hooks`, `approve`, `limits`), `instructions/<family>.md` selection, unknown-key rejection, worker-target rejection of file-path hooks/approve. |
| **H2 pi-provider** (Phase 1) | `src/providers/pi/piProvider.test.ts` — 16 faux-backend tests: message/image/file/tool-call/tool-result mapping, zod→JSON Schema conversion, stream chunk mapping (`text-delta`, `tool-call`, `reasoning-delta`, `finish`), usage incl. cached/reasoning tokens, pi retries pinned off so `retry`/`fallbackModels` remain the only retry layer. `resolveProvider`/`builtinProviders`/`importGraph`/`missingPeer` tests cover the `pi/...` spec routing, the optional-peer error (`npm install @earendil-works/pi-ai@1.0.3`) and the worker-bundle shim (pi is Node-only; `cloudflare-worker` refuses `pi` specs). |
| **H3 pi-coder** (Phase 2) | `src/subagents/piAgent.test.ts` — 9 offline tests: `piAgent()` over `createAgentSession` fixes the fixture with the `faux` provider; `deny` produces `tool.error`; `ask` emits `approval.requested` → `SubagentApprovalPause` (durable across restart via the task's `sessionId`) → resume lets exactly that one call through (Pi has no run-blocked-call API; the model re-issues it and the gate allows it once); rejection sends the note as the next turn; usage aggregates into the lead's `result.usage`; `remoteAgent.test.ts` covers `defineRemoteSubagent()`. `SubagentApprovalPause` and `defineRemoteSubagent` are now public exports. |
| **Production kit: `coding-pi`** | `examples/coding-harness/kit-pi.test.ts` — `lousho add coding-pi` installs the full directory including `subagents/coder/agent.json` (`"engine": "pi"`); `resolveAgentDir` puts the coder in the parent's `subagents` map (the `task` tool) while the explorer stays a `delegate_to_` tool; the offline e2e runs a mock lead → `task` → a real Pi session on pi-ai's faux provider that edits the installed workspace so `node --test` passes; a second run proves the coder's own `permissions` deny `rm`. `loadAgentDir.test.ts` covers the `engine: 'pi'` config: structure, `pi/` model-id enforcement, root/bad-value rejection, and `overrides.piAgent` injection. |

## Live results — all green (valid OpenRouter key)

`OPENROUTER_API_KEY` was validated against `/auth/key` (a second stored key was
found expired and rejected). With the valid key, every live suite ran and
passed. Cost: well under the `$0.05` cap per run.

| Live test | Result |
|---|---|
| `kit.test.ts` live — kit fixes `math.js`, `node --test` passes, test file untouched, `rm` denied in audit | ✅ `openrouter/openai/gpt-4o-mini` |
| `piProvider.live.test.ts` — fixture fix, `rm` denial, usage+cost | ✅ 3/3 on `pi/openrouter/openai/gpt-4o-mini` |
| `piAgent.test.ts` live — e2e delegation under $0.05 | ✅ 10/10 |
| `kit-pi.test.ts` live — **the full production stack**: pi-provider lead delegating to a real Pi coding sub-agent over OpenRouter | ✅ fixed `math.js`, `node --test` passes, test file untouched |

## Fixes made after live testing

- **`gpt-4o-mini` over-edited the pi-provider fixture**: instructed to fix only
  `add()`, it also "fixed" `subtract()` — which was already correct — breaking
  the suite it was told to leave alone. The live prompt now demands the
  smallest possible edit, preserving unrelated functions, and verifying the
  whole test suite before finishing. This is exactly why a production harness
  needs verification loops, not just edit tools.
- **`piAgent` live test timeout**: the test inherited Vitest's 5 s default;
  the kit live tests already used 120 s. Bumped to match.
- **`.live.test.ts` exclusion**: the default Vitest config excludes
  `**/*.live.test.ts`, so `piProvider.live.test.ts` must be run with
  `vitest.live.config.ts` — documented in its header.

## The production harness: `registry/coding-pi`

The gap found while connecting the harnesses: a directory kit could not
declaratively describe a Pi-backed sub-agent — `subagents` only existed as a
code-level `loadAgentDir` override. That seam is now built:

- **`"engine": "pi"`** in a `subagents/<name>/` config makes it a `piAgent()`
  instead of a nested `createAgent()` one: it lands in the parent's
  `subagents` map (the `task` tool) and its sessions run in the parent's
  directory — the same workspace the kit's own file tools touch.
- The coder's `model` is the usual `pi/<provider>/<model>` id; its
  `permissions` (serializable `agent.json` rules) gate the Pi session's own
  calls — `rm` denied, `*.test.*` edits denied, everything else allowed.
- `loadAgentDir(dir, { piAgent: { ... } })` injects `PiAgentOptions` (a faux
  `modelRuntime` in tests, a custom `sessionDir`/`agentDir` for durable
  approvals); the directory always wins `cwd`/`name`/`description`.
- Cloudflare Worker targets reject `engine` with a clear message (Pi needs
  the Node runtime); `node-server` and `docker` are the deployable targets.

Why `coding-pi` is the production candidate: it composes all three harnesses —
the installable agent directory with workspace tools, checkpoints, allow-listed
shell, permission rules, loop guard, cost cap and family instructions (H1), the
pi provider for the lead's model (H2), and a real Pi coding sub-agent with
durable session + approval pause/resume and per-sub-agent permissions (H3) —
installable as one `lousho add coding-pi` command, verified offline end to end
and live over OpenRouter.

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
  specs (worker shim explains why), and a `subagents/<name>/` directory with
  `engine: 'pi'` fails the Worker resolution with a named error. Workers
  support is a future decision.
- **Pi sessions default to `~/.pi/agent`.** A dir-declared pi sub-agent shares
  the user's Pi config/session area unless `overrides.piAgent` sets `agentDir`
  / `sessionDir`; production deployments that want isolation should set them
  (the adapter's own directories are already hermetic — `noExtensions`,
  `noSkills`, `noPromptTemplates`, `noContextFiles`).
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
  generator fix, `spec` subpath export, a `research` base kit,
  public-vs-private registry kits, Pi TUI vs ACP-only.
