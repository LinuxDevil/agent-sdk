# evaluator-loop

The **evaluator-optimizer** pattern from Anthropic's agentic taxonomy
("Building effective agents"): a writer agent drafts, an evaluator scores
the draft against a rubric, and a failing draft loops back to the writer -
carrying the critic's feedback - until the score passes or the round
budget runs out. This is the writer/critic shape CrewAI-style content
pipelines use.

| Role | Lousho feature |
|---|---|
| Writer | `createAgent()` + `writer.session()` (revision turns see earlier drafts) |
| Scorer + critic's note | `llmCritique({ provider, model, rubric })` - one judge call returns `{ score, feedback }` |

`runEvaluatorLoop({ writer, judge, prompt, passScore, maxRounds })`
returns `{ text, score, rounds, history }`; `history` holds each round's
draft, score and the feedback sent back to the writer.

## Judge feedback

`llmJudge()` resolves to a bare number, so a revision loop cannot reach
the judge's textual feedback through it (an earlier version of this
example worked around that with a second `judge.provider.generate()`
call for the critic's note). The SDK's `llmCritique()` closes that gap:
it takes the same `LLMJudgeConfig`, asks the judge for a `SCORE:` line
plus a `FEEDBACK:` line, and one provider call per round returns both
the `[0, 1]` score and the feedback the revision prompt carries back to
the writer.

## Run it

```bash
npx tsx examples/evaluator-loop/index.ts                         # offline, scripted models
OPENROUTER_API_KEY=... npx tsx examples/evaluator-loop/index.ts  # live, openrouter/openai/gpt-4o-mini
```

Offline, the writer's first draft fails on citations (score 0.42), the
critique goes back into the writer's session, and the revision passes
(score 0.91).

## Test it

```bash
npx vitest run examples/evaluator-loop
```

The tests check that a failing score triggers a revision carrying the
critic's feedback, that the loop stops at `maxRounds` returning the last
draft, and that a first-round pass needs no critique call.
