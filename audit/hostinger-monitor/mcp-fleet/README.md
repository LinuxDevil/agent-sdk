# hostinger-monitor / mcp-fleet: a read-only ops agent for a Hostinger VPS fleet

> Lives in `hostinger-monitor/mcp-fleet/` because another audit harness (an HTTP
> watchdog: `../index.ts`, `../monitor.ts`, `../FINDINGS.md`) was written into
> `hostinger-monitor/` at the same time. The two share only `../token.ts`.

## Scenario

An on-call engineer wants a fleet health report for their **real** Hostinger
VPS fleet every N minutes. The agent connects to the official Hostinger API MCP
server (`npx --package=hostinger-api-mcp@latest hostinger-vps-mcp`) through the
SDK's MCP client, gathers each VM's state, plan, IP, CPU, RAM, disk and network
metrics for the last hours, recent actions and backup age, flags anomalies, and
writes `out/report.json` and `out/report.md`.

The fleet is production infrastructure, so the agent is **strictly read-only**.

## Safety design (read this first)

The server exposes only three meta-tools: `search` (read-only), and `execute` /
`multi-execute`, which can run any of 64 API operations, including stop,
recreate, purchase, set-root-password and firewall changes. A tool-name allowlist
alone cannot express "read-only". `guard.ts` therefore allowlists
**(tool, operation)** pairs: 13 GET operations. Four independent layers
enforce it, and each one blocks a mutation by itself:

1. **Tool filtering.** `multi-execute` and any tool the server adds later are never given to the agent.
2. **`permissions` rules.** `execute` is denied unless its operation is allowlisted, the known tools are allowed, and `deny('*')` refuses everything else (fail closed).
3. **A `preToolCall` hook** applies the same decision.
4. **The `execute` descriptor is wrapped** and checks the operation again just before it calls the server, which also covers direct programmatic calls.

`repro/guard-test.ts` proves each layer with **fake** tools and a scripted mock
model. No destructive call ever reaches the real server. The real runs only
executed `vps_virtual-machines_list`, `vps_virtual-machines_metrics`,
`vps_actions_list` and `vps_backups_list`, plus `search` while enumerating the operations.

The token is read from `~/.claude.json` at runtime and handed only to the MCP
child's `env`. Every trace span (`captureContent: true`), event and SDK log line
is scanned for it at exit (`[leak-check] ... token present=false`).

## SDK features exercised

- `connectMcp()` (stdio, `approval` function, `logger`, `status()`, `close()`, lazy reconnect) and `createAgent({ mcpServers })`
- `permissions` (`allow` / `deny` / a `when` rule over arguments), `preToolCall` hooks, `onPermissionDecision`
- `postToolCall` hooks that shape large MCP results (metrics series turned into min/max/avg/latest)
- `output` (zod 4 structured output), `compaction` with a 8k `contextWindow`, `retry` with `retryOn`/`onRetry`
- `defineSchedule()` + `startSchedules()` (cron mode), `TraceExporter`, `onEvent`
- `loadMcpTools()` with fake clients, `mockModel`, `compactProviderError`, `registerModel`, `deferLoading` / `toolSearch`

## Run

From `audit/`:

```bash
npx tsx hostinger-monitor/mcp-fleet/index.ts                # one report, 6h window
npx tsx hostinger-monitor/mcp-fleet/index.ts --cron 2       # schedule '* * * * *', stop after 2 ticks
npx tsx hostinger-monitor/mcp-fleet/index.ts --no-agent     # deterministic collector only
# flags: --hours 6  --command npx|npx.cmd  --raw (unshaped MCP results)  --offer-search  --debug  --attempts 5  --retries 6
npx tsx hostinger-monitor/mcp-fleet/repro/guard-test.ts     # guard proof (fake tools, offline)
```

Files:

- `index.ts` is the agent and the schedule.
- `guard.ts` holds the read-only guard.
- `collect.ts` is a deterministic collector through the same guarded descriptor. Its numbers are the ground truth, and the agent's numbers are checked against them.
- `schema.ts` holds the zod report and the thresholds.
- `token.ts` reads the token.
- `repro/` holds one script per finding.
