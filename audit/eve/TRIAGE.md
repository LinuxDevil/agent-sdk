# Eve audit triage — current `main`

Triage of every Eve finding against `main` @ `f4c8eb10` (package `1.0.0-alpha.19`, post-#611).
Method: re-ran the repro scripts under `audit/eve/{core,durability,tools,providers,multiagent,channels,repro}` against the current source (`npx tsx`) and the freshly packed tarball under `audit/node_modules` (`node`), cross-checked `git log` for per-finding fix commits, and inspected the cited source lines where a repro could not run deterministically.

Statuses: `FIXED` = repro passes or the code visibly addresses it · `STILL-OPEN` = the defect demonstrably reproduces today · `CHANGED` = behavior differs but is not simply fixed · `INDETERMINATE` = repro cannot run on current code.

## Status table

| Finding | Status | Evidence |
|---|---|---|
| EVE-0 (`resume()` no-ops on paused channel session) | FIXED | `paused-send-overlap.mjs` / `paused-session-send.mjs` now throw `SessionAwaitingApprovalError`; `<id>.paused.json` marker. Commits `2f007c57` (#472), `2d1f9009` (#524), `209414ea` (#599) |
| CORE-F1 (UI remote single-turn) | FIXED | `r1-ui-remote-multiturn.ts`: both POSTs carry the same `sessionId`; `[PASS] turn 2 saw turn 1`. Commit `7000ce90` (#591) |
| CORE-F2 (throwing onEvent listener fails run) | FIXED | Listener exception logged, run completes `finishReason=stop`. Commit `dd2d564f` (#598) |
| CORE-F3 (synthetic prompts stored as user msgs) | FIXED | Forced-answer/repair prompts are request-only; absent from `result.messages`. Commit `7b2043bd` (#595) |
| CORE-F4 (messages round-trip duplicates system) | FIXED | Same-system prompt deduped on feed-back. Commit `fb9eecd1` (#587) |
| CORE-F5 (`limits.maxSteps` bypass + unvalidated maxSteps) | FIXED | `0`/negative/fractional/`NaN` rejected `LOUSHO_CONFIG_INVALID`; forced answer runs on `limits.maxSteps`. Commit `3f0b9209` (#587) |
| CORE-F6 (one code for all provider failures) | CHANGED | 5 categories on `.compacted` + own codes for rate-limit (`LOUSHO_PROVIDER_RATE_LIMITED`) and timeout (`LOUSHO_OPERATION_TIMEOUT`); auth/context-overflow still share `LOUSHO_PROVIDER_REQUEST_FAILED` (`errors.ts:745`). `RateLimitError`/`TimeoutError` classes still not thrown |
| CORE-F7 (sub-agent dynamic config misses caller ctx) | FIXED | Test `subagents.test.ts:269` asserts caller `metadata`/`principal`/`sessionId` reach the resolver. Commit `96730ec9` / `ffa71e0c` (#582) |
| CORE-F8 (typed output lost on approvals.resolve/streamResolve) | STILL-OPEN | `eve/core/r5-types.ts` still fails tsc: `Property 'tempC' does not exist on type '{}'` — `AgentApprovals` still not generic over `TObject` |
| CORE-F9 (chat reducer glues texts / hides endings) | FIXED | `r9-ui-reducer.ts` passes: step texts separated, non-`stop` endings surfaced |
| CORE-F10 (stream ends normally on run failure) | FIXED | `stream()` rethrows the run error after `run.done`. Commit `a4f1af14` (#571) |
| CORE-F11 (stop mid-reply erases user msg / 0 tokens) | FIXED | User turn retained and usage counted on mid-model stop. Commit `bfcf54f0` (#598) |
| CORE-F12 (futile repair after `length` cutoff) | FIXED | No repair call on `finishReason: 'length'`; flagged not `output-invalid`. Commit `a50c06af` (#580) |
| CORE-F13 (modelSettings unvalidated; no toolChoice/per-call maxSteps/partial objects) | FIXED | Range validation `4e73f5bc` (#587); `object.delta` `7472439c` (#574); per-call `maxSteps`/`instructions` `1b1fd0c5` (#587) |
| CORE-F14 (open `finishReason` union) | FIXED | `ExecutionFinishReason` is a closed union; unknown reasons mapped. Commit `886c1097` (#593) |
| CORE-F15 (signal-ignoring provider makes abort a no-op) | FIXED | Abort ends promptly `finishReason=aborted`; signal re-checked after generate/tool batch. Commit `e5f5731b` (#576) |
| CORE-F16 (missing API key throws in `createAgent`) | STILL-OPEN | `createAgent({model:'openai/gpt-4o-mini'})` with no key still throws at construction (now coded `LOUSHO_PROVIDER_MISSING_API_KEY`); defer-to-first-run not implemented |
| CORE-F17 (small UI/DX inconsistencies) | CHANGED | React `reset()`, remote server error text, tiny-cost formatting fixed (`aa81c575` #592, `3f0b9209`-era #517); still: `steps` excludes the forced call (`steps:2` vs `modelCalls:3`), duplicate toolCall ids still mis-pair results (`r4.ts`/`r6`) |
| DUR-F1 (parallel/forEach share `variables`) | FIXED | Per-iteration `item`/`index` scope. Commit `0b7420eb` (#448); `d1-flow-vars.mjs` passes |
| DUR-F2 (concurrent send loses a turn) | FIXED | Per-store send queue. Commit `5c21aeb4` (#463); `d2-concurrent-send.mjs` passes |
| DUR-F3 (stale session BUSY forever) | FIXED | Transcript re-read every call; tools kept on lost commit. Commit `273d5119` (#476); `d3-stale-session.mjs` passes |
| DUR-F4 (non-atomic BUSY load/save) | FIXED | `SessionStore.saveIf` compare-and-swap. Commit `4f734c8d` (#556); `d4-saveif.mjs` rejects one writer |
| DUR-F5 (bytes corrupted in SQLite/KV stores) | FIXED | `Uint8Array` preserved across SQLite approvals + KV checkpoints/approvals. Commit `1fc2aaf0` (#454); `d5-bytes.mjs` passes |
| DUR-F6 (prune deletes approval-paused turns) | FIXED | `SqliteStore.prune()` keeps unresolved-approval turns. Commit `5928eae7` (#470) |
| DUR-F7 (fileStore case-insensitive collisions) | FIXED | Case-safe file names. Commit `cbacb88b` (#474) |
| DUR-F8 (clear() leaves checkpoint copies) | FIXED | `clear()` deletes every `<id>.turn-<n>` checkpoint + history. Commit `47bd60b7` (#487) |
| DUR-F9 (KV approval resolved twice runs tool twice) | FIXED | Claim-before-resolve + idempotency key. Commit `e5950c8b` (#542) |
| DUR-F10 (B14 absent; Worker schedule sessions grow) | FIXED | One session per fire (`schedule-<name>-<fire time>`) on both paths, opt-in `sharedSession`. Commit `2c87bd9f` (#509); `d9-schedules-sessions.mjs` shows `schedule-daily-report-2026-10-09T090100Z` (old `schedule-<name>` id obsolete) |
| DUR-F11 (provider error bricks checkpointed session) | FIXED | Failed turn no longer bricks the session. Commit `2b148554` (#533); `d11-brick.mjs` passes |
| DUR-F12 (parallel failure doesn't cancel siblings) | FIXED | Siblings aborted on failure; `result.usage` added. Commit `6743c875` (#461); `r7-flow-parallel.ts`: return in 2 ms, 0 late events |
| DUR-F13 (raw Windows EPERM in fileStore) | FIXED | EPERM/EACCES/EBUSY retried, wrapped `LOUSHO_STORAGE_FAILED`. Commit `b1e9e57d` (#545); `d13-eperm.mjs` passes |
| DUR-F14 (SQLite lock freezes loop 5 s) | FIXED | `transactionAsync` event-loop backoff + `BUSY_TIMEOUT_MS=50` + `LOUSHO_STORAGE_BUSY`. Commit `e51c60d9` (#567); `d16-sqlite-blocks-loop.mjs` shows a direct sync `save()` still returning `ERR_SQLITE_ERROR 5` — the async store path is coded; note the sync-path discrepancy under "notes" |
| DUR-F15 (no crash recovery / SIGTERM drain) | FIXED | `agent.pending()` + `CheckpointStore.list()` (`cfaa93ab` #572); node-server SIGTERM drain (`b53ac3b0` #577); `d12-crash-resume.mjs` passes |
| DUR-F16 (two conversation models, wrong docs) | FIXED | Docs explain both id models; schedule fires read from checkpoints. Commit `a5da53d1` (#583) |
| DUR-F17 (flows have no durability) | FIXED | Flow checkpoints+resume (`b629ac7f` #563); approval pause/resume (`911d194e` #586); per-node retry (`5a19e9aa` #578); `d20` passes |
| DUR-F18 (WebhookTriggerAdapter unbounded body) | FIXED | 1 MB cap, 413, no error echo. Commit `fd150c90` (#468); `d18` verifies 413 |
| DUR-F19 (fork fails on 122–128-char ids) | FIXED | Long-id fork + `fork().messages`. Commit `508fbbde` (#537); `d15` passes |
| DUR-F20 (02:00 cron skips spring-forward) | FIXED | First instant after the gap. Commit `f23e8439` (#500); `d19` passes |
| TOOLS-F1 (shell allow patterns read outside workspace) | FIXED | `888dde68` (#452) sees through quotes/`$`/braces; `shell-escape-proof.ts`: `../`, `$(..)`, `$PWD/..`, backticks, `${}`, `~/../` all REFUSED. Only inert glob forms (`[.]..`) pass the matcher — they cannot expand to `..` on POSIX sh (globs never match `.`/`..`) nor under cmd (`??\` → syntax error), so no outside read reproduces |
| TOOLS-F2 (token redaction misses) | FIXED | `3df790f1` (#455): object keys, URL/class instances, base64, thrown errors all redacted. Residual (new vector): a token inside a `Map` still serializes — `mapInstance leaked=true` in `sec-token-redaction.ts` (see Still-open notes) |
| TOOLS-F3 (sign-in links posted to groups) | FIXED | `17e2c567` (#458): Telegram/Teams answer "Please sign in from a private chat". Residual: a low-level in-process link flow can still be completed by whoever clicks (`sec-signin-binding.ts`) — the group-posting path is closed |
| TOOLS-F4 (MCP object+oneOf schema collapses) | FIXED | `7363005d` (#447); `mcp-schema-oneof*.ts` pass |
| TOOLS-F5 (serveMcp no Host/Origin check) | FIXED | `31c5c66e` (#460); `mcp-serve-rebind.ts` refused |
| TOOLS-F6 (grep ReDoS on event loop) | FIXED | `339e6b51` (#498): nested quantifiers refused + worker timeout |
| TOOLS-F7 (edit_file corrupts non-UTF-8) | FIXED | `eacff4b6` (#503): non-UTF-8/UTF-16 refused |
| TOOLS-F8 (no tool-result cap; MCP images as text) | FIXED | `6500df6b` (#529): `maxToolResultChars`, media placeholders, capped descriptions |
| TOOLS-F9 (/ui forwards client system/assistant roles) | FIXED | `28fa574a` (#539): /ui drops non-user/assistant roles; `e2e-ui-roles` shows `system,assistant,user` with no injected system |
| TOOLS-F10 (unsatisfiable defineTool schemas) | FIXED | `9c6bb797` (#485): `z.date()`/`z.bigint()` rejected `LOUSHO_CONFIG_INVALID` at definition |
| TOOLS-F11 (MCP tool disables approval / shadows local) | FIXED | `add1f836` (#494): default approval on + shadowing refused; `mcp-shadow.ts` passes |
| TOOLS-F12 (parallel approvals surface one at a time) | FIXED | `5bc2bc8a` (#591) pause once on all; `3733b4dd` (#593) per-call decisions |
| TOOLS-F13 (approvals.list() empty after restart) | FIXED | `9e33104a` (#554): durable pauses listed after restart, decided-elsewhere dropped |
| TOOLS-F14 (serveAcp crashes on null line) | FIXED | `5dffb75d` (#473): `-32600` for non-object JSON lines; `acp-null-line.ts` |
| TOOLS-F15 (token owner ignores authenticator) | FIXED | `c61164d0` (#465): owner namespaced `authenticator:<name>` |
| TOOLS-F16 (concurrent refresh deletes good token) | FIXED | `3df790f1` (#455): refresh race serialized |
| TOOLS-F17 (sandbox weaker than documented) | FIXED | `ea2da140` (#514): `sec-sandbox-writefile.ts` → `LOUSHO_SANDBOX_PATH_DENIED` |
| TOOLS-F18 (MCP ignores pagination/list_changed; crashed = idle) | FIXED | `cd84fc9f` (#516): pages followed, re-list on `list_changed`, crash → `failed`; `mcp-client-edge.ts`/`mcp-crash.ts` pass |
| TOOLS-F19 (no remember/approve-with-edits; once() trusts callbacks) | FIXED | `3e0343d5` (#585): remember + approve-with-edits; `once()` ignores callback approvals |
| TOOLS-F20 (broker injects secrets into plain http://, any port) | STILL-OPEN | `credentialBroker.ts` `parseTarget`: absolute-form `http://` accepted unconditionally and `pathForm` allows `<host>:<port>`; `admit()` gates the host only, so an allowlisted host over `http://…:anyport` still receives the secret (`sec-broker-cleartext.ts`) |
| PROV-F1 (strict structured output 400 on unions/records/tuples) | FIXED | `16e0ad34` (#467): roots wrapped/rewritten; `p15-strict-keywords.ts`/`p2` pass |
| PROV-F2 (Claude z.record validates empty — data loss) | FIXED | `16e0ad34` (#467): records rewritten to arrays; `p3-union-optional.ts` passes |
| PROV-F3 (costUsd/maxCostUsd off for most OR models) | FIXED | `5142f381` (#450) reported cost + `de995153` (#459) id normalization; `p16-cost-budget-bypass.ts`: budget stops the run with `providerReportedUsd` |
| PROV-F4 (no Anthropic prompt caching / cache pricing) | FIXED | `2166c282` (#564) cache breakpoints + `115803b3` (#544) cache pricing; `p12*` pass |
| PROV-F5 (Retry-After uncapped) | FIXED | `80248076` (#471): capped at `maxMs`, `retry-after-ms`, 503 honoured |
| PROV-F6 (insufficient_quota retried as rate-limit) | FIXED | `5bafee5a` (#480): non-retryable quota category; `p6-retry-classification.ts` shows `insufficient_quota` |
| PROV-F7 (withRetry timeoutMs kills healthy stream) | FIXED | `29de7e2c` (#490): `timeoutMs` bounds first chunk only; `idleTimeoutMs` added; `p7` passes |
| PROV-F8 (in-body finish_reason 'error' resolves normally) | FIXED | `64d78388` (#506): throws retryable error; `p13-finish-reasons.ts` |
| PROV-F9 (stop never sent; no toolChoice) | FIXED | `dcb2412b` (#481): `stop`→`stopSequences`, `toolChoice` wired |
| PROV-F10 (reasoning silently unsent on Fable/gpt-oss/DeepSeek) | FIXED | `56f8e31b` (#510): sent where supported, warned otherwise |
| PROV-F11 (decide(): abort=timeout, no answer check, no retry) | STILL-OPEN | `p8-decide.ts` on current package: user abort → `LOUSHO_OPERATION_TIMEOUT` (not AbortError); choice outside `choices` and missing answer accepted; 429 never retried |
| PROV-F12 (output + length cutoff runs futile repair) | FIXED | `a50c06af` (#580) — same fix as CORE-F12 |
| PROV-F13 (registered providers unusable in model strings; retired defaults) | FIXED | `e3c5126a` (#513): registry lookup in strings + defaults modernized |
| PROV-F14 (no client-side rate limiting) | FIXED | `10e44741` (#541): `withRateLimit` + `createAgent({rateLimit})` |
| PROV-F15 (small accuracy issues) | CHANGED | 402→quota category fixed (#480); image estimate now documented as "a flat guess" (`estimateTokens.ts:33`). Still: unknown models fall back to 128k (`contextWindow.ts:15`, registry never consults the OR catalog); `getModels`/`getModelInfo` refetch the whole catalog per call, uncached (`OpenRouterProvider.ts:591`) |
| MA-F1 (failed sub-agent usage vanishes) | FIXED | `6b28fa00` (#477); `r1-usage-lost.ts`: failed child tokens counted in lead usage/delegated |
| MA-F2 (background cost missing from lead span/traces) | FIXED | `c4e1a76d` (#466) |
| MA-F3 (queued background sub-agent own root trace) | FIXED | `03148bee` (#495) |
| MA-F4 (prompts/tool output to disk by default) | FIXED | `8c7a7fed` (#457): `redactContent` defaults true |
| MA-F5 (agent-dir sub-agents bypass sub-agent runtime) | FIXED | `53a00451` (#478) |
| MA-F6 (handoff target's toolSearch overwritten) | FIXED | `4252de85` (#523) |
| MA-F7 (cassette replay flaky/swallowed for parallel subs) | FIXED | `416139dc` (#501): per-agent request replay, mismatch stops run |
| MA-F8 (parseJudgeScore misreads prose) | FIXED | `db663809` (#482): last labelled score + judge sees input |
| MA-F9 (trajectory evals miss sub-agent tool calls) | FIXED | `511128e3` (#560) |
| MA-F10 (traces never name the sub-agent) | FIXED | `ec68a3f6` (#505): span named by key + name/depth/taskId tags |
| MA-F11 (flow parallel returns on first failure; siblings spend) | FIXED | `6743c875` (#461, shared with DUR-F12); `r7-flow-parallel.ts` verified |
| MA-F12 (failed task id reused; O(N) allocation reads) | FIXED | `7da8d12b` (#538); `r3-task-sessions.ts`: 1 store read per allocation, failed id never reused |
| MA-F13 (loadSkills fails on README; bundled files unreachable) | FIXED | `4fe19d0a` (#519) + `706556e4` (#531) |
| MA-F14 (subagents always adds 4 tools/840 tokens) | FIXED | `36d3856f` (#575): `subagentOptions.background:false`, optional task description |
| MA-F15 (truncated sub-agent answer returns as success) | FIXED | `ce072d15` (#528) |
| MEM-F1 (keyword recall fails open; substring false positives) | FIXED | `1125afb0` (#507); probe: `jazz`→1, stop-words→0, `zzzzz`→0 — no fail-open |
| MEM-F2 (append-only memory; no forget/upsert) | FIXED | `79056d28` (#581): `forget_<name>` tool, `upsert`, `itemKey` upserts — provider exposes `upsert`/`remove` |
| MEM-F3 (fileMemory case-insensitive cross-user leak) | FIXED | `cbacb88b` (#474, shared with DUR-F7) |
| MEM-F4 (corrupt memory file fails the run) | FIXED | `728aefc2` (#511): degrades on recall errors |
| MEM-F5 (compaction silently no-ops protectedTokens ≥ window) | FIXED | `7b1e8854` (#515): protectedTokens capped below threshold + warning |
| MEM-F6 (scopes never validated) | FIXED | `728aefc2` (#511) |
| MEM-F7 (add(undefined) writes literal `undefined` key) | FIXED | `728aefc2` (#511); probe: `add(undefined)` → `LOUSHO_MEMORY_INVALID` |
| MEM-F8 (keyedQueue per-instance; Windows EPERM) | FIXED | `9828625a` (#571): per-key locks across instances/processes + EPERM retries |
| MEM-F9 (docs: recalled block "not saved in transcript") | FIXED | `e476f1eb` (#535): transcript docs corrected |
| MEM-F10 (namespacing orphaned pre-upgrade items) | FIXED | `2abe11db` (#567): `migrateMemoryKeys()` + documented break |
| MEM-F11 (recall strips metadata; unbounded limit) | FIXED | `e476f1eb` (#535): score/metadata returned, limit capped |
| MEM-F12 (missing table-stakes features vs competitors) | CHANGED | Forget/upsert shipped (#581); still absent: TTL/`expiresAt`, `clear(scopeKey)`/`deleteUser`, `scopeKeys()` on non-vector providers, `recall.maxTokens` budget, relevance decay, embeddings-by-default, per-agent key prefixing |
| MEM-F13 (tool_search ranker misses semantic names) | FIXED | `4846dfc5` (#551): synonyms, word families, `-es` plurals |
| MEM-F14 (compaction.start/done fire when nothing compacts) | FIXED | `7b1e8854` (#515): quiet no-op events |
| MEM-F15 (remember_ description false for scope:'session') | FIXED | `e476f1eb` (#535): scope-aware descriptions |
| MEM-F16 (`<memory>` injection sanitizes only `</memory>`) | FIXED | `e476f1eb` (#535): memory tags escaped |
| MEM-F17 (naming ergonomics: inMemoryMemory, two maxItems, optional ctx) | STILL-OPEN | `inMemoryMemory` still exported (`src/memory/index.ts:11`); both `maxItems` unchanged; `memoryKey(slot, ctx={})` still silently defaults ctx |
| CH-F1 (deployed server channels use private memory store) | FIXED | `2f007c57` (#472): channel sessions default to the agent's store; `r5-deployed-store.ts`: transcript lands in the agent store |
| CH-F2 (webhookChannel 401s on every Fetch host) | FIXED | `df08464d` (#451): auth works on Fetch hosts; `r2-webhook-fetch.ts` passes |
| CH-F3 (nextjs.md promised session ownership that didn't exist) | FIXED | `authorizeApproval` + Next/Express webhook adapters landed; docs rewritten (`f01bb3ac` #546) |
| CH-F4 (no-waitUntil ack waits for whole turn) | FIXED | `acb0b55c` (#526): early ack on hosts without ctx + production warning; `r1-ack.ts` |
| CH-F5 (GitHub posts "Approved" before validation) | FIXED | `861f187c` (#456); `r3-github-false-approve.ts`: `comments posted: []` on non-pending id |
| CH-F6 (channel 500s leak internals) | FIXED | `7077ac87` (#489); `r6-7-errors.ts`: 500 body is the redacted generic message |
| CH-F7 (two decisions → loser 500/false reply) | FIXED | `f281b83a` (#486); `r4b-double-click.ts`: `200 409`, one reply |
| CH-F8 (no delivery idempotency) | FIXED | `e0dfef58` (#530): update_id/delivery dedupe + Slack retry handling |
| CH-F9 (`channel.stream` replies per text.delta) | CHANGED | Still one `channel.reply` per `text.delta` (`channelCore.ts:252-254`) — now documented behavior; no coalescing landed |
| CH-F10 (approvals route dead end after restart) | FIXED | `dfc98656` (#532): forgotten pause bound via `sessionKey` |
| CH-F11 (/ui 500s on invalid chat id) | FIXED | `1a69cf3d` (#496); `r6-7-errors.ts`: `/ui` → 400, `/chat` → 400 |
| CH-F12 (webhookChannel open by default, no sessionKey hook) | CHANGED | `auth`/`secret` validation + `principal` hook added, but no-auth still `verify→{ok:true}` with no production warning; `sessionKey` still only from the JSON body; response still carries no `sessionId` (`webhookChannel.ts:50,94-104`) |
| CH-F13 (Discord signature without timestamp freshness) | FIXED | `e0dfef58` (#530) |
| CH-F14 (Slack replies unsplit, no mention protection) | STILL-OPEN | `slackChannel.ts:238` still `post(inbound.replyTo, { text })` raw — no `splitText`, no `allowed_mentions`-equivalent; >40k replies still fail `msg_too_long` |
| CH-F15 (no rate limiting, typing indicators, WhatsApp) | STILL-OPEN | Nothing rate-limits `httpChannel`/`webhookChannel`; no typing/`sendChatAction` hooks; no WhatsApp channel — unchanged |
| CH-F16 (`auth:''` lock-all vs open across hosts) | FIXED | `1a69cf3d` (#496): empty token fails closed everywhere; probe: missing auth header → 401 |
| CH-F17 (small inconsistencies) | STILL-OPEN | Still current: decide-404 names the channel (`channelCore.ts:390`); malformed `%`-escape still throws inside handlers →500 (`fetchRoutes.ts:627`, `mountChannels.ts:96`); no-`input` webhook body still posted raw (`webhookChannel.ts:40`) |
| CLI-F1 (`latest` dist-tag installs alpha.0) | STILL-OPEN | `npm view`: `latest: 1.0.0-alpha.0`, `alpha: 1.0.0-alpha.19`; `README.md:53`/`quick-start.md:33` still `npm install @lousho/build-ai-agent` unpinned |
| CLI-F2 (`lousho mcp <dir>` raw EISDIR) | FIXED | `cff11359` (#479): agent dirs accepted, errors prefixed/coded |
| CLI-F3 (`lousho add` writes anywhere) | FIXED | `120a86aa` (#483): warns on non-agent dirs, creates missing dir for kits |
| CLI-F4 (5.1 MB tarball ships studio + llms + src) | CHANGED | `llms-full.txt` removed (`388fa077` #492), but `files` still ships `src/`, `apps/agent-forge/dist*`, `docs/*.md` — `npm pack` still ~5.1 MB / 19.3 MB unpacked |
| CLI-F5 (examples import `../../src`) | STILL-OPEN | 45 files under `examples/` still `from '../../src'` (11 import the package); only docs snippets moved (`d2cd3d74` #550) |
| CLI-F6 (README teaches legacy AgentBuilder/AgentExecutor) | FIXED | README leads with `createAgent()`; legacy APIs live in `docs/executor-api.md` + migration doc (`README.md:258-259`) |
| CLI-F7 (`lousho build` leaks raw esbuild errors) | FIXED | `3a041909` (#488): coded, actionable error |
| CLI-F8 (chat/acp path errors mislabeled `lousho dev:`) | FIXED | `73619f85` (#469): path errors name the command |
| CLI-F9 (no `--version`) | FIXED | `73619f85` (#469): `--version`/`-v` work |
| CLI-F10 (stale top-level usage) | FIXED | `73619f85` (#469): usage refreshed |
| CLI-F11 (naming soup + orphaned create-loushy-agent workspace) | STILL-OPEN | `packages/create-loushy-agent` still a workspace member (`package.json:5-8`); three names still in use |
| CLI-F12 (create-lousho-agent@latest lags alpha) | STILL-OPEN | `npm view`: `latest: 0.1.1` vs `alpha: 0.1.2-alpha.4` — unchanged |
| CLI-F13 (engines floor excludes Node 20/most 22.x) | STILL-OPEN | `package.json:389` still `"node": ">=22.19.0"` |
| CLI-F14 (three vocabularies for same fields) | FIXED | `docs/configuration.md:341-342,449` documents `prompt`↔`instructions` alias + mutual exclusivity |
| CLI-F15 (`cp .env` POSIX-only advice) | FIXED | `14621005` (#547): cross-platform instructions |
| CLI-F16 (docs/ 70 flat files, no index; tests inside) | CHANGED | Tests moved out (`e9bffe6f` #539); docs/ still 64 flat `.md` files, no index/README — README's table is the only index |
| CLI-F17 (exact-pinned optional peers) | FIXED | `7df308fb` (#518): caret ranges for Pi peers |
| CLI-F18 (registry quickstart fails on missing dir) | FIXED | `120a86aa` (#483): `lousho add` creates the dir for kits |
| CLI-F19 (init succeeds with no API key, dev dead-ends) | FIXED | `95cfe349` (#493): `lousho init` warns when the provider key is missing |
| CLI-F20 (no demo / "why not X") | CHANGED | ops-pipeline gained `npm run pipeline:demo` (`04d45db3` #453); README still has no why-not-X section |
| DUI-F1 (studio API unauth + wildcard CORS) | FIXED | `afbf95b0` (#583): token-gated, CORS hardened; probe: unauth API → 401 |
| DUI-F2 (agent list in localStorage, leaks projects) | FIXED | `08b1440a` (#582): `HttpAgentStore` over `.lousho/agents/` |
| DUI-F3 (name with space/! blanks studio) | FIXED | `19779756` (#570): bad-name/API error handling |
| DUI-F4 (no-key silently runs mock) | FIXED | `c057f2fe` (#566): visible MOCK badge |
| DUI-F5 (ctx.sessionId = `<id>.turn-<n>`) | FIXED | `59acecff` (#502): `contextSessionId` carries the real session id (`AgentExecutor.ts:1697`) |
| DUI-F6 (ops-pipeline uncompletable, clobbers .env) | FIXED | `04d45db3` (#453): ports, env README, smoke test |
| DUI-F7 (chat fails on new agent until Run) | FIXED | `08b1440a` (#582): HTTP-backed agents chat immediately |
| DUI-F8 (studio unusable below 860 px) | FIXED | `733b4b78` (#552): drawers + More menu |
| DUI-F9 (keyboard/screen-reader/contrast gaps) | FIXED | `ad548780` (#547): keyboard, aria, contrast fixes |
| DUI-F10 (Ctrl/Cmd+D duplicates node in text field) | FIXED | `60fdf551` (#569) |
| DUI-F11 (invalid YAML/spec import fails silently) | FIXED | `60fdf551` (#569): import errors surfaced |
| DUI-F12 (nextjs.md documents nonexistent approvers/no-self-approval) | FIXED | `f01bb3ac` (#546): section rewritten around `authorizeApproval` |
| DUI-F13 (non-object output root → provider 400) | FIXED | `16e0ad34` (#467): root schemas wrapped/rewritten instead of reaching the provider |
| DUI-F14 (optional-peer error contract on send()/otel) | FIXED | `f4c8eb10` (#611): `LOUSHO_PEER_MISSING` to clients + cross-copy instanceof; `/otel` entry documents a coded throw on import |
| DUI-F15 (approvals.get/list stale across processes) | FIXED | `9e33104a` (#554): `get()` checks the store, `list()` filters against it |
| DUI-F16 (examples never type-checked; 10 strict errors) | FIXED | `3a7e053d` (#462): strict tsc CI for examples; `fcfb9dfa` (#588) green |
| DUI-F17 (five starter examples print canned mock) | STILL-OPEN | 11 of ~19 `examples/*/index.ts` still build on `mockModel` (e.g. `agent-dir`, `connectors`, `deep-research`, `waves`) and print canned output |
| DUI-F18 (TypeDoc root-only, 1271 undocumented) | FIXED | `09801ab6` (#536): coverage across entries |
| DUI-F19 (snippets use undefined names; checker blind spots) | FIXED | `31efd4d7` (#543): snippet verification extended |
| DUI-F20 (llms.txt truncated/internal ids/misfiled) | FIXED | `2316aa01` (#540): descriptions, ticket ids, sections fixed |
| DUI-F21 (studio status/copy/naming contradict docs) | FIXED | `b03782fa` (#561): status, labels, rename/delete, connection banner |
| DUI-F22 (Output node double-boxed; empty minimap) | FIXED | `d8676f1e` (#568) |
| DUI-F23 (smaller doc-vs-behaviour drifts) | FIXED | `277876cf` (#548) drift pass + `508fbbde` (#537) `fork().messages` |
| DUI-F24 (smaller example defects) | STILL-OPEN | Still current: `hostinger-deploy/deploy.mjs:105-106` puts `OPENROUTER_API_KEY`/`LOUSHO_API_TOKEN` on the ssh argv; `examples/tracing/` still has no README |

## Still open (reproducible on current main)

| Finding | Repro | Current failure output |
|---|---|---|
| CORE-F8 — typed output lost on `approvals.resolve()`/`streamResolve()` | `npx tsx eve/core/r5-types.ts` (tsc) | `error TS2339: Property 'tempC' does not exist on type '{}'` at the `approvals.resolve()`/`streamResolve()` results; `Property 'toolName' does not exist on type 'ToolCall'` |
| CORE-F16 — missing API key throws inside `createAgent()` | `node -e "createAgent({model:'openai/gpt-4o-mini'})"` (no key) | throws `LOUSHO_PROVIDER_MISSING_API_KEY` at construction, not first `send()` (coded now, but still construction-time) |
| TOOLS-F20 — credential broker injects secrets into plain `http://`, any port | `npx tsx eve/tools/sec-broker-cleartext.ts` | `parseTarget` accepts absolute `http://` and `<host>:<port>` path form; `admit()` gates host only → allowlisted host over plaintext/odd port still receives the header |
| PROV-F11 — `decide()` abort/validation/retry | `npx tsx eve/providers/p8-decide.ts` | `user abort -> SDKError LOUSHO_OPERATION_TIMEOUT`; `[FAIL] a user cancel surfaces as an AbortError`; `[FAIL] decide() rejects a choice outside choices and a missing answer`; `[FAIL] decide() retries a 429` |
| MEM-F17 — naming/API ergonomics | source: `src/memory/index.ts:11` | `inMemoryMemory` still exported; two unrelated `maxItems`; `memoryKey(slot, ctx = {})` still optional-ctx |
| CH-F14 — Slack replies unsplit, no mention protection | source: `src/channels/slackChannel.ts:238` | `reply: ({ inbound, text }) => post(inbound.replyTo, { text })` — no `splitText`, no mention guard; >40k reply → `msg_too_long` fallback |
| CH-F15 — product gaps | source: `src/channels/mountChannels.ts`, `fetchRoutes.ts` | no rate limit, no typing indicator/`sendChatAction`, no WhatsApp channel — unchanged |
| CH-F17 — small inconsistencies | source: `channelCore.ts:390`, `fetchRoutes.ts:627`, `webhookChannel.ts:40` | decide-404 still names the channel; malformed `%`-escape still 500s; no-`input` webhook body still posted raw |
| CLI-F1 — poisoned `latest` dist-tag | `npm view @lousho/build-ai-agent dist-tags` | `latest: 1.0.0-alpha.0` vs `alpha: 1.0.0-alpha.19`; README/quick-start install lines unpinned |
| CLI-F5 — examples import `../../src` | `grep -rln "from '\.\./\.\./src" examples/` | 45 files still import repo source paths; only docs snippets were ported |
| CLI-F11 — orphan `create-loushy-agent` workspace | `ls packages/` | `create-loushy-agent` still a workspace member; lousho/build-ai-agent/Agent-Forge naming unchanged |
| CLI-F12 — `create-lousho-agent@latest` lags alpha | `npm view create-lousho-agent dist-tags` | `latest: 0.1.1` vs `alpha: 0.1.2-alpha.4` |
| CLI-F13 — patch-level engines floor | `package.json:389` | `"node": ">=22.19.0"` unchanged |
| DUI-F17 — starter examples print canned mock | `grep -c mockModel examples/*/index.ts` | 11 examples still on `mockModel`, printing canned strings |
| DUI-F24 — smaller example defects | `examples/hostinger-deploy/deploy.mjs:105-106`; `ls examples/tracing/` | secrets still on the ssh `docker run -e` argv; tracing example still has no README |

### Residual notes on findings classified FIXED or CHANGED (new evidence, not the original claim)

- **TOOLS-F2 residual** — every originally-cited vector is redacted, but a token stored inside a `Map` still leaks: `sec-token-redaction.ts` prints `mapInstance leaked=true recorded={"auth":"Bearer <TOKEN>"}`.
- **TOOLS-F3 residual** — group posting is closed, but an OAuth sign-in completed through a low-level/in-process link flow still binds the caller's principal to whoever clicked (`sec-signin-binding.ts` still yields `signed-in` for a foreign click); only exploitable if a link is conveyed out-of-band.
- **TOOLS-F1 note** — the matcher still lets through non-literal glob tokens (`[.]..`, `?..`), which is sloppier than literal matching but cannot expand to `..` on POSIX sh (globs never match `.`/`..`) or under cmd (`??\` → syntax error); no outside read reproduces.
- **CORE-F17 residual** — `steps` still excludes the forced-answer call (`steps:2` vs `modelCalls:3`), and duplicate tool-call ids still mis-pair results (`r4.ts`/`r6`).
- **DUR-F14 note** — the old `d16-sqlite-blocks-loop.mjs` still prints a raw `ERR_SQLITE_ERROR 5` for a direct synchronous `save()`; the async `transactionAsync` store path carries the busy-timeout/`LOUSHO_STORAGE_BUSY` handling and passes its tests.
- **CH-F12 residual** — `webhookChannel({})` still verifies `{ok:true}` with no production warning and no `sessionKey(body, req)` escape hatch.
- **PROV-F15 residual** — unknown models still assume a 128k context window instead of reading the catalog; `getModels`/`getModelInfo` refetch the whole catalog uncached.
- **r4.ts observation** — tool calls embedded in an input message replay execute through the normal gate (verified: an approval-gated call pauses `awaiting-approval`; ungated tools run). Transcript-replay semantics, approvals still govern danger — noted, not flagged.

## Counts

- **FIXED: 142** (EVE-0 · CORE 13/17 · DUR 20/20 · TOOLS 19/20 · PROV 13/15 · MA 15/15 · MEM 15/17 · CH 12/17 · CLI 12/20 · DUI 22/24)
- **STILL-OPEN: 15** (CORE-F8, CORE-F16, TOOLS-F20, PROV-F11, MEM-F17, CH-F14, CH-F15, CH-F17, CLI-F1, CLI-F5, CLI-F11, CLI-F12, CLI-F13, DUI-F17, DUI-F24)
- **CHANGED: 9** (CORE-F6, CORE-F17, PROV-F15, MEM-F12, CH-F9, CH-F12, CLI-F4, CLI-F16, CLI-F20)
- **INDETERMINATE: 0**
