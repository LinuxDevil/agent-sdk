# Eve audit: multi-agent & observability

Scope: sub-agents/`task`, handoffs, flow `parallel`, skills, agent-dir sub-agents, tracing/OTel, evals, usage/cost roll-up, testing utilities. Tarball `1.0.0-alpha.19`. Repros: `audit/eve/multiagent/` (`npx tsx eve/multiagent/<file>` from `audit/`).

## Summary
- **Cost numbers break with delegation.** A sub-agent that fails after spending tokens drops its spend from `usage` and `limits` (F1). Background sub-agent cost is missing from the lead span and from `lousho traces`, which shows 100k tokens at $0.000004 (F2).
- **Traces are untrustworthy at depth 2.** Queued background children become root traces in OTel (F3). Every span is named `invoke_agent agent` (F10). Content still goes to disk by default, although B17 is marked fixed (F4).
- **Two sub-agent systems.** Agent-directory sub-agents bypass the lead's `deny`, usage, approvals and spans (F5).
- **Handoffs drop the target's own `toolSearch`** (F6).
- **Evals can't test multi-agent behavior** (F7–F9).

## Findings

### MA-F1: A sub-agent that fails after spending tokens vanishes from `result.usage` and `limits`
**Severity** high · **Lens** AI eng / SWE · **Type** bug
**Evidence** — `r1-usage-lost.ts` [A]: the child spends 1000/100 tokens and then gets a 400. The lead's usage is 20/2 and `delegated` is undefined. The budget never sees the spend, so retry loops can burn money unseen.
**Root cause** — `src/execution/delegation.ts:104-125` (`reportUsage` only runs on success); `withSubagents.ts:230-234`.
**Suggested fix** — Attach partial `RunUsage` to the executor's thrown error, and report it in `runSubagent`'s catch.

### MA-F2: Background sub-agent cost is missing from the lead span and `lousho traces`
**Severity** high · **Lens** AI eng / PM · **Type** bug
**Evidence** — `r2-otel-background.ts` [B]/[D]:
- `background=true`: the lead `lousho.cost_usd` is 0.0000042, while `result.usage.costUsd` is 0.0210042.
- `listTraces` shows 100,020 tokens next to $0.0000042.
**Root cause** — `src/execution/tracing.ts:73-75,157-160` (roll-up only adds to an open parent); `src/traces/readTraces.ts:122,136`.
**Suggested fix** — Roll up to the nearest open ancestor. Have `summarize()` sum the chat spans' cost.

### MA-F3: OTel: a queued background sub-agent becomes its own root trace
**Severity** medium · **Lens** SWE · **Type** bug
**Evidence** — `r2b-otel-queued.ts`: 9 spans in 2 traces.
**Root cause** — `src/execution/otel.ts:125-126,154` (the parent entry is deleted when its span ends).
**Suggested fix** — Keep ended span contexts until the root ends, as `fileTraceExporter` does.

### MA-F4: B17 regression: prompts and tool output still go to disk by default
**Severity** medium · **Lens** SWE · **Type** security
**Evidence** — `r2-otel-background.ts` [C]: `fileTraceExporter()` with defaults writes `SECRET-USER-INPUT`, `SECRET-SYSTEM-PROMPT`, `SECRET-TASK-PROMPT` and `SECRET-CHILD-OUT` to disk.
**Root cause** — `src/execution/genAiSpans.ts:138,161,253`; `redactContent` defaults to false (`AgentExecutor.ts:1523`, `generateStep.ts:109`).
**Suggested fix** — Default `redactContent: true` (at least with `fileTraceExporter`), and correct REPORT.md B17.

### MA-F5: Agent-directory sub-agents bypass the sub-agent runtime (deny, usage, approvals, spans)
**Severity** high · **Lens** SWE / PM / Design · **Type** bug / security
**Evidence** — `r5-agentdir-subagents.ts` with fixture `fixtures/lead-dir/`:
- `write_file` runs despite the lead's `deny('write_file')`.
- The approval is dropped ("The call did not run").
- The child's 2000 tokens are not counted.
- 0 of 12 events are tagged to the sub-agent, and the child has no spans.
**Root cause** — `src/agentDir/subagents.ts:51-66` (`agent.send(task, {signal})`), `loadAgentDir.ts:386`.
**Suggested fix** — Route directory children through `config.subagents` (the native `task` tool), and keep `delegate_to_<name>` as an alias through `runSubagent()`.

### MA-F6: The handoff target's own `toolSearch` (and `toolConcurrency`, `approvalTtlMs`) is overwritten by the lead's undefined value
**Severity** medium · **Lens** SWE / Design · **Type** bug / docs
**Evidence** — `r4-handoff-target-options.ts`. This contradicts `docs/tool-search.md:162-165`.
**Root cause** — `src/handoffAgents.ts:283-292` (`{...own, ...lead}` with undefined lead keys).
**Suggested fix** — Drop undefined lead keys and keep the target's `toolSearch`.

### MA-F7: Eval record/replay is flaky for parallel sub-agents, and the mismatch is swallowed
**Severity** medium · **Lens** AI eng / SWE · **Type** bug
**Evidence** — `r10-cassette-parallel.ts`: replay ends `stop` with a "Call #2 does not match" error inside the task result.
**Root cause** — `src/evals/cassettes.ts:134,148-152` (`match:'sequence'`); `withSubagents.ts:233-234` wraps the error as a tool failure.
**Suggested fix** — Use `match:'request'`, key cassettes per agent, and make cassette errors propagate.

### MA-F8: `parseJudgeScore` misreads judge prose
**Severity** medium · **Lens** AI eng · **Type** bug
**Evidence** — `r6-evals.ts` [A]: "1 of 5 ... Final: 0.2" scores 1, "3 of 4 ... 0.75" scores 0.3, and "Step 2 ... 0.4" scores 0.2.
**Root cause** — `src/evals/llmJudge.ts:103-116` (the first number wins), `:40-50` (the judge prompt leaves out the user input).
**Suggested fix** — Use structured `{score, reason}` or the last `SCORE:` line. Include the input in the prompt and default temperature to 0.

### MA-F9: Trajectory evals can't see sub-agent tool calls
**Severity** medium · **Lens** PM / AI eng · **Type** enhancement
**Evidence** — `r6-evals.ts` [B]: `toolCalls` contains only `task`.
**Root cause** — `src/evals/trajectory.ts:139-144`; `defineEval.ts:256-264` forwards only 7 fields.
**Suggested fix** — Collect sub-agent-tagged `tool.*` events and add a `{ subagent }` filter.

### MA-F10: Traces never name the sub-agent
**Severity** medium · **Lens** Design / AI eng · **Type** DX
**Evidence** — `r11-span-names.ts`: every span is `invoke_agent agent`.
**Root cause** — `src/createAgent.ts:1187`; `delegation.ts:221-237` does not set span attributes.
**Suggested fix** — Use the sub-agent key as `gen_ai.agent.name`, and add `lousho.subagent.name`, `lousho.subagent.depth` and `lousho.task.id`.

### MA-F11: Flow `parallel` returns on the first failure while siblings keep spending and mutating the result
**Severity** medium · **Lens** SWE · **Type** bug
**Evidence** — `r7-flow-parallel.ts`: events are appended to the result after it has returned. The result has no usage field.
**Root cause** — `src/flows/FlowExecutor.ts:515,550-554,185-192`.
**Suggested fix** — Link a child AbortController, abort siblings on failure and use `allSettled`, and add `usage` to the result.

### MA-F12: A failed task's id is reused, and id allocation costs O(N) store reads
**Severity** low · **Lens** SWE · **Type** bug / perf
**Evidence** — `r3-task-sessions.ts`.
**Root cause** — `src/subagents/taskSessions.ts:312-323`; `withSubagents.ts:236-237`.
**Suggested fix** — Use random or persisted monotonic ids reserved at allocation time.

### MA-F13: `loadSkills` fails on a README, and bundled skill files are unreachable
**Severity** low · **Lens** PM / Design · **Type** DX
**Evidence** — `r12-skills.ts`, fixture `fixtures/skills-anthropic/`.
**Root cause** — `src/skills/loadSkills.ts:193-195,223-228,249-250`; `withSkills.ts:114-120`.
**Suggested fix** — Skip README files with a warning, add a confined `read_skill_file`, and throw a coded `LOUSHO_SKILL_INVALID`.

### MA-F14: `subagents` always adds 4 tools and about 840 tokens per lead request
**Severity** low · **Lens** AI eng / perf · **Type** perf
**Evidence** — `r8-overhead.ts`.
**Root cause** — `src/subagents/withSubagents.ts:163-171,527-532`.
**Suggested fix** — Add `background: false` to turn the background tools off, and make `description` optional.

### MA-F15: A truncated sub-agent answer (`length`) is returned as a success
**Severity** low · **Lens** AI eng · **Type** bug
**Root cause** — `src/subagents/withSubagents.ts:193`.
**Suggested fix** — Add an explicit truncation note, or treat it like `max-steps`.

## Verified non-issues
- Usage roll-up with `awaitBackgroundOnFinish` and cancelled children is exact.
- Synchronous sub-agent traces nest correctly.
- gpt-4o-mini drives `task` well live.
- `llmJudge` resisted an injection at temperature 0.
- Eval usage fields are correct.
- Bad task ids give coded errors.
- Handoff run-level settings match the docs.
- `fileTraceExporter` keeps queued children in the lead's trace.
