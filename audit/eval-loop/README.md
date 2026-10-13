# eval-loop — generator↔evaluator harness (live, OpenRouter)

Replicates the dominant **"harness-centric" pattern for long-running agents**: a
generator and an evaluator with **disjoint contexts** iterate against a
**testable contract**, while a **deterministic control loop** — plain code in
`index.ts`, not the model — applies the policy `u`: continue (feed failures
back), stop (all green), or escalate (round budget exhausted).

The anti-sycophancy requirements are structural, not prompt-level: the builder
never sees the rubric or the contract internals (only its task plus whatever the
loop feeds back verbatim), the evaluator is a *separate* agent on a *separate*
session instructed to *"assume the work is broken and prove it"*, and the stop
condition is a set of predicates code can check — not a model's say-so.

## The task

The builder writes `.runs/<ts>/artifact/announcement.md` through real fs tools
(`write_file`/`edit_file`/`read_file` on a `NodeWorkspace`): a ~120–200-word
markdown announcement for **"Approvals v2"**, a fictional CI-platform feature,
for a platform-engineer audience.

### Contract C — deterministic predicates (no model)

| id | predicate |
| --- | --- |
| c1 | file exists, 120–200 words |
| c2 | mentions `approval policy` AND `audit trail` AND `rollback` |
| c3 | a ```` ``` ```` fenced block containing `require_approval: true` |
| c4 | none of `revolutionary`, `game-changer`, `blazing`, `seamless` (case-insensitive, word-bounded) |
| c5 | exactly one `#` heading and ≥1 `##` section (fenced code ignored) |

### Evaluator rubric — subjective axis (model-graded, `output` schema)

`{ clarity, technical_accuracy, audience_fit }` 0–10 each, plus
`verdict: 'pass' | 'revise'`, `feedback`, and `contract_checked` — the evaluator
must cite every contract predicate it verified.

## Architecture

```
┌─────────────────── control loop (index.ts, rounds 1..4) ───────────────────┐
│                                                                            │
│  task/feedback ──▶ BUILDER agent ──write_file──▶ artifact/announcement.md  │
│        ▲            session "builder"                     │                │
│        │            fs read/write tools                   ▼                │
│        │                                 harness predicate check c1–c5     │
│        │                                                  │                │
│        │                                                  ▼                │
│        │            EVALUATOR agent ──────────────▶ rubric + verdict       │
│        │            session "evaluator"   (read_file ONLY, hostile         │
│        │            instructions, zod output schema)      │                │
│        │                                                  ▼                │
│        └────── policy u: all c* pass && verdict="pass" ──▶ STOP           │
│                     else feed failed predicates + feedback back ──▶ next  │
│                     round; budget exhausted ──▶ ESCALATE                   │
└────────────────────────────────────────────────────────────────────────────┘
```

Both agents share `fileStore(.runs/<ts>/store)` — durable per-session JSON
transcripts — but run disjoint sessions (`builder` vs `evaluator`). A canary
string planted only in the builder's instructions proves no context leakage.

## What the harness checks

| | check |
| --- | --- |
| a | contract: all 5 predicates hold on the final artifact on disk |
| b | evaluator produced a typed rubric object (`result.object`) every round |
| c | loop converged in ≤ 4 rounds — or honestly reports `ESCALATE` |
| d | revision incorporated feedback: artifact differs between `snapshots/announcement.r<N>.md` round files |
| e | builder canary absent from evaluator prompts, outputs, transcript, and the artifact |
| f | durable disjoint sessions: `store/sessions/{builder,evaluator}.json` both exist |

## Run

```bash
cd audit
npx tsx eval-loop/index.ts
```

`OPENROUTER_API_KEY` must be set (repo-root `.env`). `AUDIT_MODEL` overrides the
model — default `openrouter/openai/gpt-4o-mini`. The evaluator needs a model
that reliably emits the structured rubric; weak models may burn steps on
`output-invalid` repairs, and a genuinely hostile evaluator can legitimately
drive the loop to `ESCALATE` — that's a valid terminal state, reported as such.

Artifacts land in `.runs/<ts>/`:

- `artifact/announcement.md` — the deliverable
- `snapshots/announcement.r<N>.md` — per-round artifact copies (check d)
- `store/sessions/*.json` — durable builder/evaluator transcripts (checks e, f)
- `events.jsonl` — per-round builder finish reasons, predicate results, rubric
  objects, and policy decisions
