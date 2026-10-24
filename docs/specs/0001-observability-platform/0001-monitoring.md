# 0001-monitoring: the fleet registry

## Summary

Live view over every agent reporting to the daemon: which bots are up, what they are doing, whether they are erroring. Alert hooks fire when an agent goes quiet or its error rate spikes.

## Decision

Agents register on first emit and heartbeat on an interval (default 60s) via the same ingest envelope (`agent.heartbeat` events). The `agents` table is the registry: `status` derives from heartbeat freshness (`healthy` < 2 intervals, `stale`, `down` beyond a threshold), not from explicit health checks.

## Surface

**Daemon**: heartbeat events upsert `agents`; a periodic sweep (every 30s) recomputes `status` and fires alert hooks on transitions. A graceful exit sends `agent.deregister` (status `stopped`); when the sweep marks an agent `down` without one (a crash), it also flips that agent's open `sessions` and unfinished `observations` to `interrupted`, so dead runs do not look alive forever.

**Studio Monitoring panel**: fleet table (name, project, status, last heartbeat, runs today, error rate today from rollups), drill into an agent's recent traces.

**Alert hooks**: a `alerts` config on the daemon (`lousho observe --webhook <url>` or an `alerts.json`): on `healthy → down` or error rate crossing a configured threshold, POST a JSON alert to configured webhook URLs (Telegram bot message is the obvious first consumer for the owner's fleet).

## Deferred to its FEATURE spec

- Alert threshold values and whether they are per agent or global.
- Whether stale agents auto prune from the registry.
- The alert payload schema consumers depend on.

## Rationale

Heartbeat plus freshness derived status avoids a separate health check protocol; the data already flowing tells us liveness for free. Webhook only alerts keep the daemon dependency free (no SMTP, no SDK for chat apps) while still reaching the user's Telegram immediately.
