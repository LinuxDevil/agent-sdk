---
description: The incident-response playbook - severity triage, signal correlation, the remediation risk tiers and how to close out an incident. Load during a live incident for the full procedure.
---

# Incident runbook

## 1. Triage the alert

- Read the alert payload: service, environment, the metric or symptom that fired, and the severity.
- Severity mapping: `critical` = customer-facing outage or data risk (work it now, escalate early), `warning` = degraded but serving (diagnose fully before acting).

## 2. Correlate signals

- `check_logs` for the failing service at `error` severity first; widen if the error lines do not explain the symptom.
- `query_metrics` on `error_rate` and `latency_p99` to confirm the alert is real and still active, `cpu`/`memory`/`restarts` for the underlying cause.
- `check_status` for replica convergence and restart count - a service flapping shows as restarts climbing.
- Look for the *dependency*: "upstream timeout (payments-db)" in app logs points at the database, not the app.

## 3. Choose a remediation inside your tier

- **Tier 0 - diagnostics** (`check_logs`, `query_metrics`, `get_runbook`, `check_status`, `post_update`): always allowed.
- **Tier 1 - staging remediation** (`restart_service`, bounded `scale_replicas` in staging): allowed without asking.
- **Tier 2 - production remediation** (`restart_service`, bounded `scale_replicas` in production): must be approved. Propose the action once, with the blast radius and rollback, and accept the decision.
- **Tier 3 - destructive or unbounded** (`drop_table`, `delete_data`, scaling to 0): never. If the diagnosis says data must change, escalate to the on-call human with `post_update` severity `critical`.

## 4. Verify

- After any action: `check_status` for convergence, `query_metrics` for the alert metric returning to baseline.
- If verification fails, diagnose again - do not repeat the same action.

## 5. Close out

- `post_update` with what happened, what you changed, and the verification result.
- The audit timeline is written automatically; your job is to keep the story it tells accurate.
