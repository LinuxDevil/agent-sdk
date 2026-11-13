---
description: improveAgent looks for a better harness offline, tests it against the current one, and returns a proposal for a person to review.
---

# Improving an agent

`improveAgent()` looks for a better set of instructions and skills for an agent,
using failing cases you give it. It only returns a proposal. Nothing is applied,
and it can't change tools, permissions or limits.

It's experimental: its results so far come from a small benchmark.

```ts
import { createAgent, defineTool } from '@linuxdevil/lousho';
import { improveAgent, renderTranscript, type Harness } from '@linuxdevil/lousho/improve';
import { mockModel } from '@linuxdevil/lousho/testing';
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
```

## How it works

1. It runs your cases on the current harness. If they all pass, it stops.
2. An invariant editor (how the agent works) and a domain editor (what it knows)
   each propose edits, and each proposal is run on the same cases.
3. A composer merges what the runs support, or changes nothing.
4. The result must beat the current harness by more than the spread between
   repeats, without making a held-out case worse or raising tokens per passing
   run by more than `maxCostIncrease`. Cost is compared only on cases that pass
   under both harnesses, because a failing run can stop early and look cheap. A
   rise within the spread between runs isn't rejected. If no case passed under
   both, `reason` says cost could not be compared, so include a held-out case
   that already passes.

A failed run looks fine to an editor when the agent never saw the check it
missed. Return `failure` from `probe` to name that check. Name the requirement,
not the fix.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `proposal` | Passed the gate. Review `diff` and `stages`, then apply it yourself |
| `keep-base` | The editors changed nothing, or the result failed the gate. `reason` says which |
| `no-failures` | Every case passed, so no editor ran |
| `outage` | The provider failed, or no run could be scored |
| `budget-exceeded` | `maxTokens` ran out |

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
