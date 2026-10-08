# log-incident: SRE incident-triage agent

**Scenario.** A pager fires at 14:12 UTC: checkout is failing. The on-call SRE runs an agent over
~38k lines of production logs (nginx access log, the API's JSON app log, the Postgres log). The
agent investigates with three log tools and returns a typed **incident report**: timeline, root
cause, trigger, blast radius, evidence lines and remediation.

The fixture data tells a real story (deterministic generator, `gen-fixtures.ts`):

| time (UTC) | event |
| --- | --- |
| 13:44 | red herring: bot scan, burst of 404s on `/wp-login.php`, `/.env` |
| 13:51 | red herring: slow analytics query on `orders` (8.4 s) |
| 14:02:13 | deploy of api **v2.41.0** (commit 9f3c2e1, "validate coupons before reserving stock") |
| 14:02-14:09 | the checkout coupon error path leaks pooled pg clients; `pg pool stats` waitingCount climbs |
| 14:09:02 | HPA scales api 4 -> 8 pods on latency, more connections |
| 14:10:40 | first `timeout exceeded when trying to connect` |
| 14:11 | Postgres `FATAL: sorry, too many clients already`; 502/504 spike on DB routes |
| 14:24 | rolling restart: brief relief, then it re-leaks |
| 14:38:05 | rollback to v2.40.3; recovered by 14:41 |
| all day | `/healthz` and `/static` stay 200 |

`logs.ts` also has `grade()`, which scores a report against this ground truth.

## SDK features exercised

| Feature | Where |
| --- | --- |
| `createAgent` + `defineTool` (zod 4) + `output` (structured output) | `agent.ts`, `logs.ts` |
| parallel tool calls (`toolConcurrency: 4`) | every run; `repro/durable-mock.ts` shows overlap |
| durable execution: `SqliteStore`, `fileStore`, `agent.resume()`, checkpoint history, crash in a child process | `index.ts`, `durable.ts`, `repro/durable-mock.ts` |
| compaction (`compaction: { contextWindow, summarizer }`, `compactMessages`, `summarizeStrategy`) on an 8K local window | `index.ts`, `scenarios/compaction.ts`, `repro/compaction-mock.ts`, `repro/summary-local.ts`, `repro/token-estimate.ts`, `repro/summary-usage.ts` |
| structured-output repair (`[output-invalid]` step, `finishReason: 'output-invalid'`) | `scenarios/output-repair.ts` |
| cancellation (`send({ signal })`) mid-tool, mid-generation, non-cooperative tool | `scenarios/cancel.ts` |
| `retry` / `withRetry` against a fault-injecting proxy (500s, hangs, slow server, mid-stream errors, bad port) | `proxy.ts`, `scenarios/resilience.ts`, `repro/badport.ts` |
| `fileTraceExporter` + `npx lousho traces` | `index.ts` |

## Run

```bash
cd audit
npx tsx log-incident/gen-fixtures.ts             # writes log-incident/fixtures/ (38,324 lines, deterministic)
STREAM=0 npx tsx log-incident/index.ts            # main triage run (SQLite store, traces, compaction)
npx lousho traces --dir log-incident/.lousho/traces

npx tsx log-incident/durable.ts exit-in-tool:2    # live crash inside a tool + resume in a new process
npx tsx log-incident/repro/durable-mock.ts        # deterministic crash/resume matrix (mockModel, child processes)
STREAM=0 npx tsx log-incident/scenarios/cancel.ts
npx tsx log-incident/scenarios/resilience.ts      # fault-injecting proxy on :1242
npx tsx log-incident/scenarios/output-repair.ts   # offline matrix + live corruption
npx tsx log-incident/repro/compaction-mock.ts     # deterministic compaction behaviour
STREAM=0 npx tsx log-incident/scenarios/compaction.ts
```

Environment knobs: `STREAM=0` makes the provider report no streaming so `send()` uses
`generate()` even with an `onEvent` listener (needed for retries to work against LM Studio, see
FINDINGS F2); `MAX_TOKENS` (default 2500) caps each model call; `MAX_LINE` clips log lines;
`RETRIES`, `RESUMES`.

The LM Studio box is shared and loaded with an 8K context (`loaded_context_length: 8192`). Under
load from other agents it answers *any* request, even a 26-token one, with
`Context size has been exceeded.` (see RUN_LOG.md), so the main run wraps `send()` in a
resume loop: it is a real use of durable execution, not a test artefact.
