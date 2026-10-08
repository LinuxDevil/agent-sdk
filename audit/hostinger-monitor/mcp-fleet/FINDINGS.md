# hostinger-monitor / mcp-fleet: findings

This harness is a read-only Hostinger fleet monitor running on the real
`hostinger-api-mcp` server, with the local LM Studio model. Files outside
`mcp-fleet/` belong to a separate OpenRouter session. Repro scripts and logs
are in `repro/`.

## Outcome

- **Deterministic collector.** It gathers each VM's state, plan, IP,
  CPU/RAM/disk/network, recent actions and backup age, flags anomalies, and
  writes `out/report.json` and `out/report.md`. It works end to end.
- **The agent's zod-structured report never completed:**
  - **8k context load:** every attempt overflowed. That is environmental.
  - **32k context load:** one run reached step 6 and then a model call hung
    for 20 minutes (see F12).
  - **Latest runs:** the Hostinger API returned `HTTP 500 [VPS:9999]`.
- **Safety.** The server exposes only `search`, `execute` and
  `multi-execute`, and all 64 operations, including destructive ones, go
  through `execute`. Read-only access is enforced on (tool, operation) pairs
  with a 13-GET allowlist, using four independent layers:
  - drop `multi-execute`;
  - a `permissions` rule on `operation`, plus `deny('*')`;
  - a `preToolCall` hook;
  - a wrapped `execute`.

  `repro/guard-test.ts` proves each layer with fake tools. No destructive call
  was made.
- **Token hygiene.** The token never appeared in traces (content capture on),
  events, audit entries, errors, results or the agent object.
- **Verified fine:**
  - On Windows, `npx` and `npx.cmd` both launch, through cross-spawn.
  - `close()` reaps the 4-process tree in about 55 ms.
  - Schema round-trips keep descriptions and constraints.

## Findings

### F1: MCP text results reach the model twice, double-escaped

| | |
|---|---|
| **Severity** | medium |
| **Type** | perf |
| **Evidence** | A 9,675-char result becomes a 21,031-char tool message (×2.17). |
| **Root cause** | `src/tools/mcp/result.ts:136-147` returns both `text` and `content[].text`, and `src/execution/toolResult.ts:17-19` serializes the whole object. |
| **Fix** | When every content part is text, return the joined text, or only the structured part. |

### F2: MCP tool calls ignore the run's abort signal and cannot time out

| | |
|---|---|
| **Severity** | medium |
| **Type** | bug |
| **Evidence** | An abort fired at 300 ms only resolved at 3,018 ms. |
| **Root cause** | `src/tools/mcp/McpToolLoader.ts:169-170` calls `client.callTool()` with no `RequestOptions`. |
| **Fix** | Forward `{ signal, timeout }`, and add `timeoutMs` to the server spec. |

### F3: llama.cpp / LM Studio context-overflow errors are classified `unknown`

| | |
|---|---|
| **Severity** | medium |
| **Type** | bug |
| **Evidence** | `repro/ctx-overflow-category.ts`. A 500 overflow is marked retryable and sent 3 times. |
| **Root cause** | The pattern at `src/execution/errors.ts:322-323` misses this wording. |
| **See also** | `_cross` X1 |

### F4: Retry layers stack

| | |
|---|---|
| **Severity** | medium |
| **Type** | DX |
| **Evidence** | With `retry: false`, 3 HTTP requests are still sent (the ai SDK's hidden `maxRetries: 2`). With an explicit `retry`, 12 requests (4 × 3). |
| **Root cause** | `src/providers/aiSdkProvider.ts:352` and `src/createAgent.ts:1340-1352`. |
| **Fix** | Set `maxRetries: 0` on the ai SDK and own retries in one place. |
| **See also** | log-incident F11 |

### F5: MCP start failures are opaque

| | |
|---|---|
| **Severity** | medium |
| **Type** | DX |
| **Evidence** | "Command not found", an npm 404 and exit code 3 all surface as `MCP error -32000: Connection closed`. There is no error code, exit code or stderr. A server that never answers hangs for a fixed 60 s. |
| **Root cause** | `src/tools/mcp/connect.ts:72-78` and `:209`. The spec has no `stderr`, `cwd` or `connectTimeoutMs` field. |
| **Fix** | Capture the last N lines of stderr and the exit code into a coded `LOUSHO_MCP_START_FAILED` error, and add the missing spec fields. |

### F6: No per-server tool include/exclude, and `approval` cannot see arguments

| | |
|---|---|
| **Severity** | medium |
| **Type** | enhancement / security |
| **Evidence** | Meta-tool servers need hand-built argument-level guards. Server hints are unreliable: Hostinger marks `purchase` and `restart` as non-destructive. |
| **Root cause** | `src/spec/schema.ts:61-99` and `src/tools/mcp/McpToolLoader.ts:43-54`. |
| **Fix** | Add `tools: { include, exclude }` per server, and pass args to the MCP `approval` predicate. |

### F7: MCP tool names are neither sanitized nor validated

| | |
|---|---|
| **Severity** | low |
| **Type** | bug |
| **Evidence** | Names with dots, spaces or slashes, or 75 characters long, are passed through. OpenAI requires `^[a-zA-Z0-9_-]{1,64}$`. `defineTool`, `openApiTools` and `serveMcp` all validate or sanitize names. |
| **Root cause** | `src/tools/mcp/McpToolLoader.ts:145` |
| **Fix** | Sanitize names and keep a map back to the original MCP name. |

### F8: `startSchedules()` does not keep the process alive, and `stop()` cannot be awaited

| | |
|---|---|
| **Severity** | medium |
| **Type** | DX |
| **Evidence** | A script that only starts a schedule exits after 78 ms without firing. |
| **Root cause** | `src/schedules/startSchedules.ts:25` calls `unref()`, and `stop()` returns `void` while a run is still in flight (`:19-21`, `:82`). |
| **Fix** | Add a `keepAlive` option, or document the behavior, and make `stop()` return a promise that drains in-flight runs. |

### F9: Prompt schedules silently swallow non-successful runs

| | |
|---|---|
| **Severity** | medium |
| **Type** | bug |
| **Evidence** | An `awaiting-approval` run does not call `onError` and leaves a pending approval on every tick. `output-invalid` is also silent. |
| **Root cause** | `src/schedules/fireSchedule.ts:17-18` |
| **Fix** | Report every non-`stop` finish reason through `onError` or `onResult`. |

### F10: Unknown models silently get a 128k window, and there is no output reserve

| | |
|---|---|
| **Severity** | low |
| **Type** | DX |
| **Root cause** | `src/context/compaction.ts:80` and `:286-289` |
| **See also** | `_cross` X2 |

### F11: `agent.ready()` after `agent.close()` does not reconnect

| | |
|---|---|
| **Severity** | low |
| **Type** | DX |
| **Root cause** | The connection is cached in `src/tools/mcp/agentMcp.ts:62-74`. There is also no `status()` or logger for `mcpServers`. |

### F12: Model calls have no default timeout

| | |
|---|---|
| **Severity** | low |
| **Type** | DX |
| **Evidence** | One request hung for 13+ minutes and every later cron tick was skipped. The trigger was environmental (a model reload mid-request), but nothing bounds it unless the user sets `limits.maxDurationMs` or `retry.timeoutMs`. |
| **Fix** | Add a sensible default per-call idle timeout, for example "no stream chunk for 120 s". |
