# data-analyst

The "chat with your database" archetype (Vanna, Databricks Genie, every
text-to-SQL agent) assembled from one `createAgent()` call: a natural-language
question comes in, `get_schema` lets the agent inspect the CREATE TABLEs and
row counts, `run_query` executes the SELECT the agent writes, and the agent
answers with real rows.

| Layer | Lousho feature |
|---|---|
| Schema introspection | `defineTool()` `get_schema` over the CREATE TABLEs |
| Query execution | `defineTool()` `run_query` on Node's built-in `node:sqlite` |
| Read-only layer 1 (tool) | `run_query.execute()` refuses anything that is not a single SELECT/WITH before it touches SQLite |
| Read-only layer 2 (policy) | a `deny` permission rule with a `when` predicate refuses the same calls at the gate - audited (`onPermissionDecision`) and returned as a `kind: 'denied'` tool error with the rule's reason |
| Read-only layer 3 (production) | open the real connection `readOnly: true` or use read-only credentials - the demo seeds an in-memory database, which must be writable while it is seeded |

## Run it

```bash
npx tsx examples/data-analyst/index.ts                         # offline, scripted model
OPENROUTER_API_KEY=... npx tsx examples/data-analyst/index.ts  # live, openrouter/openai/gpt-4o-mini
```

Offline, a scripted mock model walks the loop; the `run_query` calls still
execute for real against the in-memory `node:sqlite` database, so the run
needs no network and no API key.

## Test it

```bash
npx vitest run examples/data-analyst
```

The tests check that the agent introspects the schema before querying, that a
`DELETE`/`DROP` attempt is refused by both the tool and the permission rule,
and that answers come back with real rows.
