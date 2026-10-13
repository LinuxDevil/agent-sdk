# sdr-outreach — AI-SDR harness with a human approval queue (live, OpenRouter)

Replicates the production **AI SDR** pattern (Reply.io / AiSDR / Mesh-Pilot
style — *drafts-as-pull-requests*): an agent works a CRM lead queue —
enrich, qualify against the ICP, draft personalized cold outreach — but
**can never send**. Every outbound draft stops in a durable human approval
queue (`needsApproval: true` on `draft_email`: the pending approval record,
persisted by `fileStore`, IS the queue entry). A rejection carries reviewer
feedback back to the model, which redrafts.

Sending belongs to a **different principal with a different tool allowlist**:
a second agent (`sender`) whose tools are only `send_email` + `log_activity`.
The SDR's tool list simply omits `send_email`, so there is no code path from
drafting to sending inside the drafting agent. `send_email` is itself
approval-gated **and** its `execute()` refuses any draft not marked approved
— defense in depth, exercised in phase 3 against a seeded `draft-rogue`
that never went through the queue.

## Tool allowlists

| tool | `sdr` | `sender` | gated? |
| --- | --- | --- | --- |
| `list_leads` / `get_lead` / `enrich_lead` | ✓ | — | no |
| `mark_disqualified` | ✓ | — | no |
| `draft_email` | ✓ | — | **needsApproval** — the durable pause is the review queue |
| `log_activity` | ✓ | ✓ | no |
| `send_email` | — | ✓ | **needsApproval** + execute() refuses non-`approved` drafts |

## Phases / checks

| Phase | Check |
| --- | --- |
| 1 — work the queue | the deterministic operator approves drafts that reference the lead's real signal and **rejects exactly one draft** (first draft for `lead-2`, once) with the feedback note *"too generic — mention their Series B and the async-standup angle"* — the agent must redraft incorporating it |
| 2 — send | the `sender` agent is handed the approved draft ids and sends them; each `send_email` call pauses for approval too |
| 3 — defense in depth | the harness calls the send path directly on `draft-rogue` (status `pending`, never queued) — it must refuse |

Assertions at the end: the out-of-ICP lead is `disqualified`; every ICP lead
(`lead-1..3`) got an `enrich_lead` call; `approval.requested` events for
`draft_email` equal the decisions made and created drafts equal approved
calls (no draft escaped review); the rejected lead was redrafted mentioning
the feedback; `sent[]` contains only approved drafts; `events.jsonl` plus
per-lead CRM activities record the full enrich → draft → approve → send
chain; the paused approval was persisted under `store/` at pause time.

## Run

```bash
cd audit
npx tsx sdr-outreach/index.ts
```

`OPENROUTER_API_KEY` must be set (repo-root `.env`). `AUDIT_MODEL` overrides
the model (default `openrouter/openai/gpt-4o-mini`).

Run artifacts land in `.runs/<ts>/`: a `leads.json` copy, `store/` (the
durable session + approvals store — `sdr/` and `sender/` subdirs),
`events.jsonl` (the audit log), and `crm-snapshot.json` (final leads,
drafts and sent mail).
