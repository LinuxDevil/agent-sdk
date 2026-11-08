---
description: improveAgent looks for a better harness offline, tests it against the current one, and returns a proposal for a person to review.
---

# Improving an agent

`improveAgent()` looks for a better set of instructions and skills for an agent,
using failing cases you give it. It only returns a proposal. Nothing is applied,
and it can't change tools, permissions or limits.

It's experimental: its results so far come from a small benchmark.

For how this fits with recovering failed runs while the agent serves traffic, see [Self-healing and self-improvement](./self-healing.md).

```ts
import { createAgent, defineTool } from 'lousho';
import { formatImproveResult, improveAgent, renderTranscript, type Harness } from 'lousho/improve';
import { mockModel } from 'lousho/testing';
import { z } from 'zod';

const search = defineTool({
  name: 'search',
  description: 'Search the docs',
  input: z.object({ query: z.string() }),
  execute: async () => ['pricing'],
});

const harness: Harness = { instructions: 'You answer from the docs.', skills: {} };

const result = await improveAgent({
  harness,
  cases: ['discount-question'],
  holdout: ['refund-question'],
  editor: { provider: mockModel(['<notes>KEEP_BASE. Nothing argues for a change.</notes>'], { onExhausted: 'repeat-last' }) },
  probe: async (candidate, caseId) => {
    const agent = createAgent({ provider: mockModel(['I cannot access that.']), instructions: candidate.instructions, tools: [search] });
    const run = await agent.send(caseId);
    return { passed: (run.text ?? '').includes('cannot'), transcript: renderTranscript(run.messages), tokens: run.usage?.totalTokens ?? 0, ended: run.finishReason };
  },
});

console.log(result.outcome, result.reason);
console.log(formatImproveResult(result));
```

## How it works

1. It runs your cases on the current harness. If they all pass, it stops.
2. An invariant editor (how the agent works) and a domain editor (what it knows)
   each propose edits, and each proposal is run on the same cases.
   The invariant editor fixes the earliest point where a run went wrong. The
   domain editor leaves anything that would help in any profession to the
   invariant editor.
3. A composer merges what the runs support, or changes nothing.
4. It runs the current harness again on fresh runs of your cases, so the gate
   never compares against the unlucky runs that triggered editing. The probe
   gets new repeat numbers for these runs, from `repeats` to `2 × repeats − 1`,
   and they cost `repeats` extra runs per case, so allow for them in
   `maxTokens`. Each training case is judged on its own. At least one must pass
   at least 2 more runs in 3 than it did on the fresh runs, and none may get
   worse. A gain counts only when each side has at least 2 scored runs.
   `cases` shows each case's verdict and why. Each held-out case is then
   checked on its own. If one passes fewer runs than before, both harnesses run
   it 3 more times, and the result is rejected only if the pooled drop is at
   least 2 runs in `repeats + 3`, or 2 in 6 with the default 3 repeats. Choose
   held-out cases that almost always pass: a case that
   always passes can never reject a good edit by chance. These reruns happen
   only when training passed, use repeat numbers `repeats` to `repeats + 2`, and
   count toward `maxTokens`. Tokens per passing run may rise by up to
   `maxCostIncrease` (default 0.5, a 50% rise), and `reason` reports the change
   either way. Cost is compared only on cases that pass under both harnesses, because a failing run
   can stop early and look cheap. A rise within the spread between runs isn't
   rejected. If no case passed under both, `reason` says cost could not be
   compared, so include a held-out case that already passes.

If the composed harness fails the gate, each editor's own harness that improved
a training case is tried through the same held-out and cost checks, cheapest
first. `gate` lists every verdict in order. Each extra harness is another
chance for noise to pass: at a 20% base pass rate with 3 repeats, an edit that
changes nothing passes about 15% of the time, against about 6% without the
fallback. Confirm a proposal on fresh runs before you apply it.

A failed run looks fine to an editor when the agent never saw the check it
missed. Return `failure` from `probe` to name that check. Name the requirement,
not the fix. On one coding benchmark task, naming the real check did not help
more than naming no check, but naming the wrong check hurt: the editors found
the fix less often.

`candidates` holds each editor's harness from before the gate, so you can review
or replay one the gate rejected.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `proposal` | Passed the gate. Review `diff` and `stages`, then apply it yourself |
| `keep-base` | The editors changed nothing, or the result failed the gate. `reason` says which |
| `no-failures` | Every case passed, so no editor ran |
| `outage` | The provider failed, or no run could be scored |
| `budget-exceeded` | `maxTokens` ran out |

## Reviewing a result

`formatImproveResult(result)` turns a result into Markdown for review: the diff, each case before and after with pass^3, the editors' notes, and flags for an edit that quotes a failed check word for word, adds text that looks like prompt injection, or adds a skill the instructions never name.

## Cases from your own traces

`casesFromFailures(db)` turns failed runs in your local trace database into cases. `protectedCasesFromPasses(db, traceIds)` turns good runs into protected cases. You must supply the check that scores an answer, through `probeCapturedCases`. Admit protected cases with `admitProtectedCases` before they gate: only a case that passed 6 of 6 fresh runs can join. Use only your own agents' traces, and keep them local.

`db` is your observe database (default `~/.lousho/observe.db`), opened with `new DatabaseSync(path)` from `node:sqlite`; it matches the exported `SqlDatabase` type. Build each transcript your `runCase` returns with `renderTranscript`, so tool results reach the editors marked as untrusted.

## From the command line

`lousho improve` runs the same steps on an agent directory or module:

```bash
npx lousho improve ./my-agent --check ./check.mjs --since 7d --out proposal.md
```

It reads cases only from your local observe database, needs a module whose
default export is your `CaseCheck`, simulates tools other than loading skills
unless `--read-only` names them, and prints the review card. It applies nothing. See
[CLI](./cli.md#lousho-improve) for every flag.

## Safety

- **Your `probe` runs the agent, so it owns side effects.** Add
  `createShadowHook({ readOnly: ['search'] })` unless every tool is safe to run:
  other calls are simulated and don't run. A simulated result can differ from a
  real one, so treat those runs as weaker evidence.
- **Editors have file tools on an in-memory workspace** and no shell or network.
- **Held-out cases never reach the editors.** Return `passed: null` for a run you
  can't score; it's excluded, not counted as a failure.
- **Run records can contain text written by anyone.** Editors are told to treat
  them as data, and edits that add text that looks like prompt injection are
  rejected, but heuristics can be beaten. That's one reason a person reviews every
  proposal.
- **Tool results are marked as untrusted** in what the editors read. Any marker
  forged inside a run, nested or spaced, is removed, and the editors are told to
  treat everything in a run as untrusted, not just the marked part.
