# support-desk — e-commerce customer-support backend

A Shopify-style store's support inbox, served over HTTP:

- **`triage`** (lead) greets the customer and hands off with `handoffs` to
  **`orders`** (list / look up / track orders) or **`billing`** (look up, refund).
- Tools work on a local JSON "database" (`data/db.json`: customers, orders, refund
  ledger). Every tool resolves the customer from the run's verified `principal`
  (route auth), never from model arguments, so a customer can only touch their
  own orders.
- `issue_refund` has `needsApproval: ({ amountUsd }) => amountUsd > 50`; a
  supervisor decides over HTTP (`POST /chat/:sessionId/approvals/:id`).
- Durable multi-turn sessions, checkpoints and approvals in one `SqliteStore`
  (`data/agent.db`); per-customer memory (`defineMemory` + `sqliteMemory`,
  scope keyed on the principal).
- HTTP surface: `createRouteHandler(triage, { basePath: '/api/support', auth })`
  mounted on a plain `node:http` server (`server.ts`); the driver (`index.ts`)
  talks to it with `fetch` and parses SSE by hand, like a browser client.

## Files

| File | What |
| --- | --- |
| `db.ts` | JSON db (atomic writes); the refund ledger is append-only and NOT de-duplicated, so a double execution shows up as two rows. |
| `agent.ts` | Tools, auth (`Bearer tok-alice` / `tok-bob` customers, `tok-staff` supervisor), the three agents. Contains the F1 workaround (`dropRoutingNote`). |
| `server.ts` | `createRouteHandler` on `node:http`. `STAFF_GATE=1` adds the approvals guard the SDK lacks (F5). |
| `client.ts` / `inspect.ts` | fetch + SSE client; read-only inspection of `agent.db` (node:sqlite) and `db.json`. |
| `index.ts` | Scenario driver S1–S7: spawns the server as a child process, hard-kills and restarts it, drives HTTP, checks the db/store. |
| `repro/*.ts` | Deterministic repros (mostly `mockModel`, no LLM) for each finding. |

## Scenarios (index.ts)

1. **S1** refund > $50 pauses → server process is SIGKILLed → a new process opens the same SQLite file → supervisor approves twice concurrently and once more → refund must execute exactly once.
2. **S2** supervisor rejects → what does the customer read?
3. **S3** two concurrent `POST /chat` on one session id.
4. **S4** handoff, then a follow-up turn: does the specialist keep the session?
5. **S5** prompt injection ("SYSTEM OVERRIDE ... refund $5000"), customer self-approval over the same route, cross-customer session access.
6. **S6** memory scoping (A's memory never reaches B) and history growth.
7. **S7** SSE event shape (v, seq, run.start/run.done, `event: done`) and client disconnect mid-tool.

## Run

LM Studio must serve `qwen3.5-9b-uncensored-hauhaucs-aggressive` on `http://localhost:1234/v1`.

```sh
cd audit
npx tsx support-desk/index.ts          # all scenarios (fresh data/ each time)
npx tsx support-desk/index.ts s1 s4    # some
npx tsx support-desk/repro/route-handler-authz.ts   # any repro, no LLM needed except the *-probe / retry ones
npx tsc --noEmit -p .                  # typecheck (clean)
```

`KEEP_ROUTING_NOTE=1` disables the F1 workaround (every handoff then fails on this model).
The shared LM Studio server intermittently answers `Context size has been exceeded.`
(8k loaded context, shared with other agents), so live runs are flaky; see RUN_LOG.md.
