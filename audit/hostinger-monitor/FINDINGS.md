# hostinger-monitor — audit findings

Harness: `hostinger-monitor/` — a VPS/service health watchdog run **live**
against OpenRouter (`openrouter/openai/gpt-4o-mini`) via the packed tarball
(`@lousho/build-ai-agent@1.0.0-alpha.18` in `audit/node_modules`). Run:

```bash
npx tsx hostinger-monitor/index.ts   # from audit/
```

## Live scenario (what actually ran)

Catalog of 5 targets — `lousho-docs` (200 ✓), `openrouter-models` (200 ✓),
`hostinger-vps-api` (`GET https://developers.hostinger.com/api/vps/v1/virtual-machines`,
**HTTP 200 with a real bearer token** ✓), `lousho-missing-page` (HTTP 404 →
degraded), `dead-vps-sim` (`http://127.0.0.1:9/` → connection refused → down).

- **Tick 1** (agent A, `SqliteStore` #1): the model called `list_monitored`,
  fanned out 5 concurrent `check_endpoint` calls, called `open_incident` for
  `dead-vps-sim` (accepted → `inc-muzd2ygj-zcwqt`, critical) **and** for
  `lousho-missing-page` (refused by the tool floor: 404 is degraded, not a hard
  failure). Structured report: `severity: critical, confidence: 0.9`.
- **Restart sim**: `store1.close()` → new `SqliteStore` on the same
  `.runs/monitor.db` + new agent → `session('monitor-main').load()` resumed
  the full 17-message transcript.
- **Tick 2** (agent B): re-checked all 5 targets; `open_incident` for
  `dead-vps-sim` deduped (`already open`), the 404 retry refused again.
  `incidents.json` still holds exactly one record. Report:
  `severity: critical, confidence: 0.95`.

Every PASS line in the run output reflects the above; no FAILs.

## Pass/fail per surface

| Surface | Result |
|---|---|
| `defineTool` HTTP tools (zod v4 input) | PASS — 5 tools; `toolConcurrency: 4` genuinely parallelized the checks |
| Hostinger API tool path | PASS — conditional on token; real `GET /api/vps/v1/virtual-machines` → 200 |
| `defineSchedule` validation | PASS — bad cron and missing `prompt`/`run` both throw `LOUSHO_SCHEDULE_INVALID` |
| `startSchedules` cron loop | PASS — injected `now`/`setTimer` drove the real `parseCronExpression.nextRun` → arm → wait → fire → re-arm path (armed 243 782 ms to the next `*/5` boundary, re-armed after firing) |
| `fireSchedule` | **FAIL (not public)** — see F1 |
| `SqliteStore` durability | PASS — transcript survived a new store + new agent; checkpoints are written per turn and deleted on success (`AgentSession.ts:700,762`), so `checkpoints`/`checkpoint_history` empty post-run is by design |
| `output` structured report | PASS — `result.object` validated both ticks; no `outputError` |
| Decision logic / escalation floor | PASS — exactly the hard-failed set has open incidents; degraded 404 never escalated; dedupe on tick 2 |

## Findings

### F1 — `fireSchedule` is implemented but not exported (low–medium, API gap)

`src/schedules/fireSchedule.ts` defines the single-fire primitive — it even
accepts a `sessionId` — and `startSchedules` calls it internally, but
`src/schedules/index.ts` exports only `defineSchedule`/`isDefinedSchedule`/
`startSchedules`, and there is no `schedules` subpath in `package.json`.

```ts
import { fireSchedule } from '@lousho/build-ai-agent';
// SyntaxError: The requested module ... does not provide an export named 'fireSchedule'
```

Repro: this harness's first draft. Operational impact: there is no supported
"run this schedule **now**" (the standard ops/testing move for cron jobs).
Workaround used here: drive `startSchedules` with the injected `now`/`setTimer`
seam — works, but the fire's completion/error is only observable via `run()`
side-effects or `onError`, since `startSchedules` does not await fires.
Fix: export `fireSchedule` (and `scheduleName`) or add `runScheduleNow(agent, schedule, { sessionId })`.

### F2 — in-process `prompt` schedules are always ephemeral (enhancement)

`startSchedules` → `fireSchedule(agent, schedule, name, new Date(target))`
never passes `sessionId`, so a `prompt` fire runs `agent.send(prompt)` with no
session: the turn is neither transcripted in `store.sessions` nor resumable.
Contrast with the documented Cloudflare path (`docs/schedules.md`): "Each
trigger has its own session, `schedule-<name>`", inspectable afterwards.
For a watchdog, durable per-schedule sessions are exactly what you want.
Fix: add `sessionId`/`session` to `ScheduleInput`, or default prompt fires to
a `schedule-<name>` session like the Worker target.

### F3 — cron granularity is minute-level only (enhancement)

`parseCronExpression` supports 5 fields (`minute hour dom month dow`) and
`@hourly/@daily/@weekly/@monthly` — no seconds field, no `@every 30s`, no
`@reboot`. Health-check cadences are commonly sub-minute. Works as documented;
the injected-clock seam makes slow crons testable regardless.

### F4 — `decide()` cannot run through OpenRouter (doc/scope note, not a bug)

`src/decisions/decide.ts` POSTs `{baseURL}/decisions` (default
`api.openai.com`, model `gpt-6-luna`) and is explicit that it "is not part of
the chat-completions surface, so it does not go through providers or
OpenRouter." So the typed-decision/confidence-floor pattern cannot reuse an
OpenRouter deployment. This harness implements the floor in the `output`
schema (`severity` + `confidence`) plus tool-side enforcement instead, which
worked. Worth a mention in `docs/decisions.md` that OpenRouter users need
that pattern.

### F5 — instructions alone did not stop the model from escalating noise (behavioral note)

On **both** ticks, gpt-4o-mini called `open_incident` for the 404 target with
`severity: "high"` despite explicit "never open an incident for a wrong-status
endpoint" instructions. The tool's own floor refused it both times
(`opened: false, reason: refused: ... not a hard failure`), the model accepted
the refusal and moved on — clean tool-error/refusal propagation through the
executor. Lesson for real deployments: put policy in tools/guardrails, not
just the system prompt. (The SDK made this trivially easy — returning a plain
`{ opened: false, reason }` object is all it took.)

### F6 — `output` enforcement is prompt-level on models without structured outputs (observation)

`extendRunOptions` appends `outputInstruction(schema)` to the system prompt
(`AgentExecutor.ts:687`); `toOutput` in `aiSdkProvider.ts:211` only attaches
the JSON schema to `response_format` when the ai-sdk model reports
`supportsStructuredOutputs`. For `openrouter/openai/gpt-4o-mini` the run
produced valid `object`s both ticks — in practice fine, but on weaker models
the guarantee is only as strong as prompt-following, and failures surface as
`finishReason: 'output-invalid'` + `outputError` (untested here; both ticks
parsed clean).

## What worked well

- `createAgent({ model: 'openrouter/openai/gpt-4o-mini' })` resolved the
  provider and `OPENROUTER_API_KEY` with zero config.
- Parallel tool execution under `toolConcurrency: 4` (4 checks in one step).
- `result.object` typing (`InferSchemaOutput`) flowed through `send`,
  `session.send`, and the schedule `run` body.
- `session({ id }).load()` is a clean read-only durability probe after restart.
- `SqliteStore` + plain-file `incidents.json` both survived the simulated
  restart; `.runs/` layout kept every artifact inspectable
  (`checks.jsonl`, `tick1-report.json`, `tick2-report.json`, `monitor.db`).
- `defineSchedule` fails fast with `LOUSHO_SCHEDULE_INVALID` — validation at
  definition, not first fire, as documented.
- `onEvent` gave a complete tool-call trace (`tool.start`/`tool.done`) with no
  missing events across both agents.

## Usage / cost observed

Tick 1: 6 model calls, ~8.9k tokens, ≈ $0.0015. Tick 2: 5 calls, ~12.4k
tokens, ≈ $0.0020 (growing transcript). `usage.costUsd` populated per step.
