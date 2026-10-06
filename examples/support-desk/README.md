# support-desk

The production support archetype (OpenAI Swarm's shape) built on
`createAgent({ handoffs })`: a triage agent classifies the request and hands
the *whole conversation* to a specialist, which replies to the customer itself
and owns every later turn until it hands back.

```
user -> triage --transfer_to_billing-----> billing     (orders, refunds)
             \--transfer_to_techSupport--> techSupport (diagnostics, tickets)
```

Why handoffs and not subagents: a `handoff` transfers control (the run goes
on as the target, with its instructions and tools, and later `session.send()`
turns go straight to it), while a `subagent` task call returns a result and
the lead keeps owning the conversation. Once a request is classified, the
specialist - not the router - should talk to the customer.

| Wiring | Lousho feature |
|---|---|
| Validated routing args | `handoff(target, { input })` gives `transfer_to_billing` a structured schema (`{ reason, orderId? }`) |
| Clean specialist transcript | `inputFilter: handoffFilters.removeToolCalls` drops triage's tool noise; the SDK's routing note (who was transferred, with the validated args) survives |
| Approval-gated refund | `permissions: [ask('issue_refund')]` pauses the call; the run's `approve` decides it - set on the *triage* agent, since a handoff target's own `approve` is never consulted (createAgent warns) |
| Hand-back | `handoffs` arrays are read every run, so the specialists can hand back to triage without a circular construction problem |

## Run it

```bash
npx tsx examples/support-desk/index.ts                         # offline, scripted models
OPENROUTER_API_KEY=... npx tsx examples/support-desk/index.ts  # live, openrouter/openai/gpt-4o-mini
```

Offline, a scripted conversation runs: broken order -> triage -> billing ->
`lookup_order` -> `issue_refund` paused -> human approves -> refund -> a
follow-up turn answered by billing directly.

## Test it

```bash
npx vitest run examples/support-desk
```

The tests check that the handoff transfers control to billing (and stays
there on later turns), that the refund pauses for approval and resumes after
it, and that the routing args reach the specialist as a system note.
