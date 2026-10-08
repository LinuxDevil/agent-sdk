# RUN_LOG — incident-responder

Live run against `openrouter/openai/gpt-4o-mini` (`npx tsx incident-responder/index.ts`,
from `audit/`). Output below is the final clean run (run6); noise trimmed.
Earlier runs (run1–run5) also captured the model's variance — see notes.

```
model: openrouter/openai/gpt-4o-mini
[PASS] env: OPENROUTER_API_KEY :: key present (not printed)
[PASS] decide() via OpenRouter :: fails as documented (OpenAI-only endpoint):
       SDKError code=LOUSHO_PROVIDER_REQUEST_FAILED ::
       decide() failed: POST https://openrouter.ai/api/v1/decisions returned 404.
webhook listening at http://127.0.0.1:60751/channels/alerts
[PASS] webhook: unsigned request rejected :: status=401
[PASS] webhook: bad signature rejected :: status=401
[PASS] webhook: stale timestamp rejected (replay protection) :: status=401

--- firing signed alert INC-7001 (checkout 5xx spike) ---
webhook run finished in 14.1s
finishReason: awaiting-approval | steps: 3 | approvalId: b5a336e2-8465-4f71-909b-1ecb5b262858
toolCalls: ["task","task","task","task","restart_service"]
text:            <-- EMPTY: bare tool-call turn, see F3 in FINDINGS.md
restartRequests so far: [{"service":"checkout","reason":"High rate of HTTP 502/503 errors..."}]
[PASS] webhook: signed alert accepted, run paused for approval ::
       status=200 finishReason=awaiting-approval approvalId=b5a336e2-...
[PASS] sub-agents: 3 investigators fanned out in parallel ::
       spans=logs 96869-98081 | metrics 96913-98128 | deploys 96935-98143;
       single-turn-3x-task=true   (one assistant message carried all 3 `task` calls)
[PASS] sub-agents: isolation (same tool name `query_telemetry`, 3 distinct backends) ::
       distinct investigators ran: logs, metrics, deploys
[PASS] durable store: pending approval persisted to disk ::
       .lousho/approvals/b5a336e2-....json tool=restart_service
[PASS] approvals.get(id) reads the pause back :: toolName=restart_service args={service:checkout,...}
[PASS] durable store: paused turn checkpointed on disk ::
       checkpoints/inc-7001.turn-0.json status=awaiting-approval
[PASS] durable store: session checkpoint marked awaiting-approval (resume refuses) ::
       inc-7001.resume() -> SessionAwaitingApprovalError

--- approving via POST /channels/alerts/approvals/b5a336e2-... (HMAC-signed) ---
[PASS] approval: paused run resumed via HTTP approvals route :: status=200 finishReason=stop
[PASS] remediation: restart_service executed only after approval :: executed=[{service:checkout,...}]
[PASS] handoff: transfer_to_report_writer called ::
       toolCalls in resumed run: ["transfer_to_report_writer","write_incident_report"]
[PASS] handoff: report-writer produced incidents/INC-7001.md :: INC-7001.md (1436 bytes)
[PASS] durable store: session transcript persisted; resolved approval claimed & deleted ::
       sessions=inc-7001.json (+4 subagent task sessions); approval file gone=true
[FAIL] approvals.get(<invalid id>) :: throws LOUSHO_CONFIG_INVALID instead of returning undefined
[PASS] fork: a finished session turn has no checkpoint history to fork ::
       refused: fork: session 'inc-7001' has no checkpoint at step 0 (steps kept: none).

--- firing signed alert INC-7002 (ambiguous staging-api alert) ---
[PASS] confidence floor: no remediation, escalated to human ::
       finishReason=stop restartRequests+0 text="severity low / confidence 0.9 ... escalated"

=== artifacts ===
approvals/:            (empty — claimed & deleted on resolve, by design)
sessions/:  inc-7001.json + 8 subagent-task-*.json   (LOU-Y6 task conversations persisted)
checkpoints/:          (empty — turn checkpoints deleted on commit, by design; see F2)
incidents/:  INC-7001.md
```

## Variance across runs (gpt-4o-mini)

- **run2**: triage returned `confidence 0.5` on clear evidence under a stricter rubric →
  commander correctly escalated instead of remediating. Confidence floor logic verified
  in both directions across runs.
- **run3**: the model chose `background: true` for the three `task` calls, then polled
  `agent_status` **8 times** before one `agent_await`, then ended with a summary without
  deciding. Reproducible small-model behaviour; instructions hardened ("do NOT use
  background mode") fixed it. Not an SDK bug, but the polling loop is a real token sink.
- **runs 4–6**: clean end-to-end pipeline.

## incidents/INC-7001.md (excerpt, written by report_writer after handoff)

```
# Incident Report: INC-7001
Severity: High | Confidence: 0.9
Root-cause hypothesis: checkout@2.14.0 (deployed 13:58Z) migrated PaymentGateway to a
new providerClient -> NullPointerException + upstream timeouts -> 42% 5xx from 14:02Z.
Remediation: checkout restarted (approved via approvals route).
```
