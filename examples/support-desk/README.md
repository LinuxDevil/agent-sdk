# support-desk

Swarm-style customer support built on `createAgent({ handoffs })`: a triage
agent classifies the request and hands the **whole conversation** to a
specialist (billing or techSupport), which then owns every later turn of the
session until it hands back.

Unlike `examples/support-bot` (one agent, no routing), this example is a small
agent mesh: handoffs mean control *transfers* — the specialist answers the
customer itself — whereas `subagents` would return control to the lead.

Highlights:

- `handoff(target, { input })` gives the transfer tool a structured schema
  (`{ reason, orderId? }`), so routing is validated data.
- `handoffFilters.removeToolCalls` + an appended routing note shape what the
  specialist sees.
- `permissions: [ask('issue_refund')]` gates the specialist's write tool;
  `approve` on the triage decides it (approval is an option of the run's
  starting agent), or the run pauses for `agent.approvals.resolve()`.
- Specialists can hand back to triage via a `handoffs` array filled after
  construction.

Run the scripted offline demo:

```sh
npx tsx examples/support-desk/index.ts
```

With `OPENROUTER_API_KEY` set it runs live on `openrouter/openai/gpt-4o-mini`.

Tests:

```sh
npx vitest run examples/support-desk
```
