---
description: How Lousho recovers a failed run now (agent.recover(), a diagnosis retry, outage pauses, a progress guard) and heals the agent itself (healOnce, lousho improve), which applies tested instruction and skill edits by default and rolls them back on a regression.
---

# Self-healing and self-improvement

Lousho handles failures in two layers:

| Layer | What it does | When it acts | Who decides |
| --- | --- | --- | --- |
| [Recover a run now](#recover-a-run-now) | Resumes interrupted runs, retries with backoff, tries once more with a note about the error, pauses during a provider outage, stops a run that makes no progress | While the agent serves traffic | The loop, within limits you set. A run it gives up on waits for a person |
| [Heal the agent itself](#heal-the-agent-itself) | Turns failed runs into edits to the instructions and skills, tests them, applies one that passes, checks it again on real runs, and rolls it back if it hurts | On each `lousho improve` cycle, or on a timer with `--watch` | The gate, by default (auto mode). In manual mode, a person approves each edit |

The first layer never changes the agent. It only finishes runs or stops them.
The second layer changes the agent's instructions and skills, and nothing else.
It is experimental, and it can be stopped at any time: see
[the kill switch](#heal-the-agent-itself).

This page is an overview. Each section links to the page with the full details.

## Recover a run now

Give the agent a checkpoint store and start `agent.recover()` once per process.
Every `intervalMs` (default 30 seconds) it lists `agent.pending()` and resumes
each interrupted run from its last checkpoint, so completed steps don't run
again.

```ts
import { createAgent, createProgressGuard } from '@linuxdevil/lousho';
import { SqliteStore } from '@linuxdevil/lousho/sqlite';

const agent = createAgent({
  provider,
  store: new SqliteStore('./.lousho/jobs.db'),
  hooks: [createProgressGuard()],
});

const recovery = agent.recover({
  retryWithDiagnosis: true,
  onRecovered: (run) => console.log('recovered', run.sessionId),
  onQuarantined: (run) => console.warn('needs a person', run.sessionId, run.lastError?.message),
  onOutage: (paused) => console.warn(paused ? 'provider down, paused' : 'provider back'),
  onError: (error, run) => console.error('recovery failed', run?.sessionId, error),
});
```

Call `recovery.stop()`, or abort the `signal` option, on shutdown.

What the loop does with failures:

- **Backoff.** A run that failed is skipped until its backoff passes:
  `intervalMs` doubled for each failed attempt in a row, up to 15 minutes.
- **Quarantine.** After `maxAttempts` failures in a row (default 10), the loop
  stops resuming the run and calls `onQuarantined(run)` once. `agent.pending()`
  still lists it, and `agent.resume()` still runs it, so a person can decide.
  Saving progress resets the count.
- **Retry with a diagnosis.** With `retryWithDiagnosis: true` (default `false`),
  a run that reaches the cap first gets one more try: a fork named `<id>.heal`,
  resumed from the same step, with a note saying why the run failed. The note
  quotes the error as data and caps its length. If the fork finishes, the
  original is deleted and `onRecovered` reports the original's id. If the fork
  also reaches the cap, both are quarantined. This applies to `send()` runs, not
  session turns, and the store must keep a
  [checkpoint history](./durable-execution.md#checkpoint-history). A fork that
  passed can later be evidence for `improveAgent()`: see
  [Recovery forks as evidence](./improve.md#recovery-forks-as-evidence).
- **Errors that won't go away.** A run whose last error has `retryable: false`,
  such as a 400 from the provider, is left alone.
- **Provider outages.** After 3 provider failures in a row, across any runs, the
  loop pauses and calls `onOutage(true)`. It then tries one run at a time, at
  growing intervals, and calls `onOutage(false)` once one gets through. Runs
  aren't quarantined for provider failures while it's paused. A bad API key
  doesn't count as an outage.
- **Approvals.** A run paused on an approval or a question is left for a person.

Every replica can run `recover()`: [run leases](./durable-execution.md#run-leases)
make sure only one of them resumes a run. See
[Recovering automatically](./durable-execution.md#recovering-automatically) for
the full behavior.

### Stop a run that makes no progress

Recovery restarts runs that were cut short. A run that is still going but stuck,
such as one calling a failing tool again and again, needs a hook instead.
`createProgressGuard()` adds a hint to a tool result that keeps failing the same
way, then denies the tool or the repeated call. Once it has denied `maxDenials`
calls (default 3), the next denial stops the run with
[`LOUSHO_RUN_NO_PROGRESS`](./errors.md#lousho_run_no_progress). That error is
recorded as not retryable, so `agent.recover()` won't resume the run.

Each hint, denial and stop is streamed as a `heal.action` event:

```ts
import { createAgent, createProgressGuard } from '@linuxdevil/lousho';

const agent = createAgent({ provider, hooks: [createProgressGuard()] });

for await (const event of agent.stream('Where is order A-1?')) {
  if (event.type === 'heal.action') console.log(event.action, event.toolName, event.reason);
}
```

To check what a tool produced, not only whether it failed, add
`createOutputCheck()`. See [Hooks](./hooks.md#stop-a-run-that-makes-no-progress)
for both, and [Stream events](./stream-events.md) for the `heal.action` fields.

### Watch it

- The `recover()` callbacks: `onRecovered`, `onQuarantined`, `onOutage` and
  `onError`. A throwing callback doesn't stop the loop.
- `agent.pending()` lists every unfinished run with `lastError` and `attempts`,
  including quarantined ones.
- A result the progress guard replaced is marked on the tool's span as
  `lousho.tool.replaced_by_hook`, and a denial is recorded as the span's error.
  See [Tracing and observability](./observability.md) for spans and the local
  observe daemon.

## Heal the agent itself

The self-healing loop works on an agent directory whose instructions live in
`instructions.md` and whose skills live in `skills/<name>/SKILL.md`. It's
experimental.

```bash
npx lousho improve ./my-agent --check ./check.mjs
npx lousho improve ./my-agent --check ./check.mjs --watch --interval 15m
```

Each cycle:

1. takes the failed runs of the agent's current revision from your local
   observe database;
2. has editors propose edits to the instructions and skills, and gates them
   against fresh runs and held-out cases;
3. replays the winner on fresh runs (the canary);
4. in **auto mode (the default)** applies it, and in **manual mode** queues it
   for `lousho improve approve`;
5. replays the protected cases right away (the corpus guard) and rolls back on
   a regression.

With `--watch`, a monitor then compares the agent's real runs before and after
the edit and rolls it back on a significant drop, in both modes. Every change
is saved as a revision and recorded in a hash-chained audit log, and
`lousho improve rollback <dir> --by <name>` undoes one by hand. By default it
makes at most 1 automatic apply, 4 cycles and 2,000,000 tokens a day, and
waits 24 hours after a rollback.

**Kill switch.** `lousho improve pause <dir>` (the file `.lousho/improve.stop`),
`LOUSHO_IMPROVE=off`, or `"enabled": false` in `improve.json` stops it.
`--dry-run` prints the proposal and writes nothing.

See [The self-healing loop](./improve.md#the-self-healing-loop) for each step,
[Approval modes](./improve.md#approval-modes), and
[Safety](./improve.md#safety) for what it can and can't change.

### Live evidence

On 2026-11-09 the loop ran live on synthetic fixtures, with
`qwen/qwen3.7-flash` as the agent and one attempt per scenario (three for the
planted editor edit). Every scenario passed: a true fix was applied and kept,
a planted edit was rejected by the gate twice out of two, a planted edit forced
past the gate was rolled back on the first tick, and the no-op, injection,
healthy, kill switch, manual, budget, stable monitor and traffic canary
scenarios behaved as specified. The audit log verified in every directory.
Auto mode stays the default. The sample is small, so the loop stays
experimental until the full benchmark (5 to 10 attempts per scenario) runs:
`npx tsx examples/heal-benchmark/loop.ts --live --out <file.jsonl>`.

### The engine: `improveAgent()`

Each cycle runs `improveAgent()` from `lousho/improve`. On its own, it looks for
better instructions and skills using failing cases you give it, and returns a
proposal without writing anything.

```ts
import { createAgent } from '@linuxdevil/lousho';
import { formatImproveResult, improveAgent, renderTranscript } from '@linuxdevil/lousho/improve';

const result = await improveAgent({
  harness: { instructions: 'You answer from the docs.', skills: {} },
  cases: ['discount-question'],
  holdout: ['refund-question'],
  editor: { provider },
  maxTokens: 500_000,
  probe: async (candidate, caseId) => {
    const agent = createAgent({ provider, instructions: candidate.instructions });
    const run = await agent.send(caseId);
    return { passed: (run.text ?? '').includes('cannot'), transcript: renderTranscript(run.messages), tokens: run.usage?.totalTokens ?? 0, ended: run.finishReason };
  },
});

if (result.outcome === 'proposal') console.log(formatImproveResult(result));
```

What it will and won't do:

- **It only returns a proposal.** An `outcome` of `proposal` comes with a `diff`,
  and `formatImproveResult()` turns it into a readable card. The loop applies
  it after the canary, or `applyProposal()` does when you call it.
- **It can only change instructions and skills.** It can't change tools,
  permissions or limits.
- **It tests before it proposes.** Each candidate runs your cases again and must
  improve at least one training case without making any case worse, including
  held-out cases the editors never see. It also checks the cost per passing run
  against `maxCostIncrease` (default 0.5).
- **Your `probe` runs the agent, so it owns side effects.** Add
  `createShadowHook({ readOnly: [...] })` unless every tool is safe to run.

Cases can come from your own traces: `casesFromFailures(db)` turns failed runs in
your local observe database into cases. Tool results in them reach the editors
marked as untrusted.

`lousho improve <agent> --check <module> --dry-run` runs it alone and prints the
proposal for review; see [CLI](./cli.md#lousho-improve).

See [Improving an agent](./improve.md) for the gate, the outcomes and the safety
notes.

## How the layers fit together

A run the first layer gives up on, quarantined or stopped with
`LOUSHO_RUN_NO_PROGRESS`, is a sign that something in the agent needs to change.
If the cause is a tool, fix the tool: the second layer can't. If the cause is in
the instructions or skills, those failed runs become cases for the next cycle.
In auto mode the loop applies an edit that passes its checks; in manual mode a
person decides. The second layer also reads the first layer's `.heal` forks
that passed as evidence, with `--with-recoveries`.
