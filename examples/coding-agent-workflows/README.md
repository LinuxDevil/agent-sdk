# coding-agent-workflows

A coding agent driven by **deterministic workflows** whose routing is a **typed decision** — the Lousho equivalent of TypeSafe's Jev / "System One" pattern ([introducing-system-one-models-and-jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).

Jev models answer structured probabilistic questions — classify, route, score, verify — instead of generating text. The Lousho form of that is `createAgent({ output: DECISION })`: the model returns `{ route, confidence, reason }` validated by a zod schema (readable as `result.object`), and the workflow branches on the typed fields.

```text
request ──► TRIAGE { route, confidence, reason }   ◄── the Jev-style step
                │ 'fix'      ∧ confident ──► fix flow:      edit → verify
                │ 'refactor' ∧ confident ──► refactor flow: plan → edit → verify
                │ 'explain'  ∧ confident ──► explain flow:  read-only llmCall
                │ confidence < floor     ──► careful path (refactor), whatever
                                            the route said — calibrated abstention
```

Two properties worth stealing:

- **Calibrated abstention.** `confidenceFloor` (default 0.7) routes low-confidence decisions to the careful workflow — the model declares uncertainty, the harness degrades gracefully instead of trusting a shaky route.
- **Typed degradation.** An unparseable triage reply returns `confidence: 0` → careful path. There is no path where a malformed decision silently becomes "fix things".

Run it:

```bash
npm run example:coding-agent-workflows            # offline
OPENROUTER_API_KEY=… npx tsx examples/coding-agent-workflows/index.ts
```

The workflows reuse the [phase-pipeline](../phase-pipeline/) shape; the typed decision generalizes to any classify/route/verify step — see [docs/prompting-techniques.md](../../docs/prompting-techniques.md#typed-decisions-system-one-style).
