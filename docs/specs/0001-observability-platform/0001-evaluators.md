# 0001-evaluators: scores beside runs

## Summary

`src/evals` already defines evals, judges, and cassettes; this child makes their results first class platform data. Every eval run emits score rows tied to the trace it evaluated, so regressions are visible in Studio beside the runs that caused them.

## Decision

Eval execution emits `score` ingest events: `lousho eval` results, `llmJudge` verdicts, and any agent self eval attach to the run's `trace_id`. Studio shows scores on the trace detail and an eval history view per agent and per eval name.

## Surface

**Emitter**: eval runners call the same reporter. Score mapping from the existing `EvalResult` shape: one score row per `AssertionResult`, `name` = `<evalName>/<assertionName>`, `llmJudge` verdicts land with `source: "judge"`, everything else `source: "eval"`. `trace_id` binds to the *exercised run's* trace; the eval harness run gets its own linked trace so judgement context stays inspectable.

**Studio eval panels**:
- Scores on trace detail: inline with the observations they judged.
- Eval history: per eval name, score over time, pass rate trend, linked traces for failures.
- CI surface: `lousho eval --observe` ships scores to the daemon, so CI runs appear in the same history.

## Deferred to its FEATURE spec

- Whether human feedback scores (a thumbs widget in Studio) write back through ingest or a Studio only route.
- How drift detection (`src/evals/drift.ts`) surfaces: as scores, as a separate panel, or both.

## Rationale

Evals without trace linkage are numbers without context: a failing score must reach the run that produced it in one click. Reusing the ingest pipeline keeps eval data inside the same store and retention story instead of a second system (basis: Langfuse scores attach to traces the same way).
