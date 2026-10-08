# research-analyst

A deep-research analyst pipeline built on the packed `@lousho/build-ai-agent`
SDK, run **live** against OpenRouter (`openrouter/openai/gpt-4o-mini`).

Real-world scenario: a question comes in — *"What breaks first when a Node.js
app is under memory pressure?"* — a coordinator decomposes it, parallel
researcher sub-agents work the slices against a small curated corpus, a strict
verifier finds gaps, one bounded extension wave covers them, a writer assembles
a structured report, and every run's tokens/cost are reconciled.

## Pipeline

```
question ─▶ coordinator (lead agent, `task` tool)
              │  3× task{agent:'researcher'} in ONE model turn → parallel
              ▼
            researcher × N   (clean context, knowledge_search tool)
              │  cited briefs
              ▼
            verifier         (output: { pass, gaps[] })
              │  gaps? ──▶ extension wave (maxWaves = 2)
              ▼
            writer           (output: { title, sections[], citations[], confidence })
              │
              ▼
        usage ledger + estimateCost parity, JSONL traces, llmJudge score
```

## SDK surfaces exercised

| Surface | Where |
| --- | --- |
| `subagents` + parallel `task` calls (clean-context fan-out) | `coordinator` → `researcher` |
| `output` structured output (zod 4) | verifier `{pass,gaps[]}`, writer `{title,sections,citations,confidence}` |
| `defineTool` | `knowledge_search` over `corpus.ts` |
| `usage` / `delegated` / `stepUsage` / `costUsd` / `formatUsage` | per-run ledger + invariants |
| `estimateCost` parity | sum(costUsd) == estimateCost(model totals) |
| `fileTraceExporter`, `listTraces`, `readTrace`, `withSpan` | `traces/<date>/*.jsonl`; span-overlap parallelism proof |
| `llmJudge` | report scored 0..1 (`allowOutsideJudgeRunner`) |
| `session()` + `store.sessions` task resume | `repro/task-resume.ts` |
| abort mid-fan-out | `repro/abort-fanout.ts` |
| config validation | `repro/subagent-no-description.ts`, `repro/judge-guard.ts` |

## Run

```bash
cd E:\agent-sdk\audit
npx tsx research-analyst/index.ts            # default question
npx tsx research-analyst/index.ts "your question"
```

Needs `OPENROUTER_API_KEY` (loaded by `_shared/env.ts` from the repo-root `.env`).
A full run is ~20 model calls on gpt-4o-mini (~$0.005, ~40 s wall).

Artifacts: `report.json` (structured report + usage ledger),
`traces/<YYYY-MM-DD>/*.jsonl` (one file per trace; coordinator traces contain
the nested `invoke_agent researcher` / `execute_tool task` spans).

## Repros (see FINDINGS.md)

```bash
npx tsx research-analyst/repro/judge-guard.ts              # offline: llmJudge runner guard
npx tsx research-analyst/repro/subagent-no-description.ts  # offline: createAgent fail-fast
npx tsx research-analyst/repro/task-resume.ts              # live: LOU-Y6 taskId resume
npx tsx research-analyst/repro/abort-fanout.ts             # live: abort mid-fan-out
```
