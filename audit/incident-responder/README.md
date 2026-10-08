# incident-responder

On-call incident-response agent built on the **packed** `@lousho/build-ai-agent@1.0.0-alpha.18`
tarball, run **live** against OpenRouter (`openrouter/openai/gpt-4o-mini`).

## Scenario

A PagerDuty-style alert arrives as a signed webhook → the commander agent fans out
three investigator sub-agents (logs / metrics / deploys, backed by mock telemetry
tools) → a `severity-triage` sub-agent returns a typed `{severity, confidence,
rationale}` decision → if the decision clears the confidence floor the proposed
`restart_service` remediation **pauses the run for human approval** → a signed
HTTP approval resumes the run → the fix executes → the run **hands off** to a
`report_writer` specialist → an incident report markdown file is produced.

A second, ambiguous alert (staging-api, no anomalies) exercises the confidence
floor: no remediation is requested and the incident escalates to a human.

## SDK surfaces exercised

| Surface | API used |
|---|---|
| Trigger / webhook intake | `webhookChannel()` + `mountChannels()` (HMAC-SHA256 + timestamp replay protection); `POST /channels/alerts` |
| Sub-agent fan-out | `createAgent({ subagents })` → the `task` tool; 3 parallel calls in one model turn |
| Typed decision | `createAgent({ output })` zod schema on the triage sub-agent; `decide()` probed on OpenRouter (fails 404 — OpenAI-only endpoint, documented) |
| Approval-gated remediation | `defineTool({ needsApproval: true })` → run pauses `awaiting-approval`; resumed via `POST /channels/alerts/approvals/:id` |
| Handoff | `createAgent({ handoffs: [handoff(reportWriter)] })` → `transfer_to_report_writer` |
| Durable store | `createAgent({ store: fileStore('.lousho') })` — sessions, turn checkpoints, pending approvals on disk |
| Extras | `hooks` (audit `preToolCall`), `agent.approvals.get/list`, `agent.resume()` (SessionAwaitingApprovalError), `agent.fork()` |

## Run

```bash
cd E:\agent-sdk\audit
npx tsx incident-responder/index.ts
```

Requires `OPENROUTER_API_KEY` in `E:\agent-sdk\.env`. No real infrastructure is
touched — all telemetry is fixture data and `restart_service` just records the call.

## Files

- `index.ts` — HTTP wiring, HMAC signing, both scenarios, PASS/FAIL reports
- `agents.ts` — agent/tool/sub-agent/handoff wiring
- `.lousho/` — fileStore artifacts created at run time
- `incidents/` — generated incident reports
- `RUN_LOG.md` — representative live run output
- `FINDINGS.md` — audit findings
