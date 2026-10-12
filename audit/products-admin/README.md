# products-admin — real-task coding-agent harness (live, OpenRouter)

Same machinery as `coding-agent/` (plan mode → approval-gated writes → durable
session → loop guard), but the objective is a **real greenfield build**, not a
canned bug: the agent must scaffold a working **products admin dashboard CRUD**
into an empty workspace.

## What the agent builds

Zero-dependency Node ESM + TypeScript (native strip-types):

- `src/store.ts` — JSON-file product store (`id, name, sku, price, stock, createdAt, updatedAt`), validated, duplicate-SKU rejected
- `src/api.ts` — `node:http` REST: `GET/POST /api/products`, `GET/PUT/DELETE /api/products/:id`, JSON `{error}` on 400/404/405
- `src/server.ts` — entry point (`PORT` env, default 3100)
- `public/index.html` — single-page admin dashboard: products table + create/edit/delete forms over `fetch('/api/products')`
- `test/api.test.ts` — `node --test` suite on an ephemeral port over real `fetch()`

## What the harness proves

| Phase | Check |
| --- | --- |
| 1 — plan mode | reads run; an ordered `write_file` is denied before approval |
| 2 — build | every write/shell call pauses → operator policy approves in-workspace writes and `node --test`/`node -e` only; `node src/server.ts` is denied (a foreground server would block the tool) |
| 3 — harness verification | the driver itself boots `src/server.ts` on a real port and does the full CRUD over HTTP, checks duplicate-SKU 400, missing-id 404, and that `/` serves a real dashboard page |

## Run

```bash
cd audit
npx tsx products-admin/index.ts      # or: npm run products
```

`OPENROUTER_API_KEY` must be set (repo-root `.env`). `AUDIT_MODEL` overrides the
model — the default `openrouter/openai/gpt-4o-mini` plans and uses tools fine but
**cannot reliably finish an open-ended greenfield build** (wrong ESM specifiers,
`fetch` shadowing, retrying the identical command under the loop guard). Verified
end-to-end green with `AUDIT_MODEL=openrouter/anthropic/claude-haiku-4.5`:
15 agent-written tests pass and the live CRUD check is clean.

Run artifacts land in `.runs/<ts>/` (`project/` = the built app, `store/` = the
durable session store, `events.jsonl` = the audit log).
