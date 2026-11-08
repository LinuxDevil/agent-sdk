---
description: How Lousho recovers a failed run now (agent.recover(), a diagnosis retry, outage pauses, a progress guard) and proposes instruction and skill edits for later (improveAgent), which a person always approves.
---

# Self-healing and self-improvement

Lousho handles failures in two layers:

| Layer | What it does | When it acts | Who decides |
| --- | --- | --- | --- |
| [Recover a run now](#recover-a-run-now) | Resumes interrupted runs, retries with backoff, tries once more with a note about the error, pauses during a provider outage, stops a run that makes no progress | While the agent serves traffic | The loop, within limits you set. A run it gives up on waits for a person |
| [Propose edits for later](#propose-edits-for-later) | Looks for better instructions and skills using failing cases, and tests them against the current ones | Offline, when you run it | A person. Nothing is applied for you |

The first layer never changes the agent. It only finishes runs or stops them.
The second layer suggests changes to the agent but never makes them.

This page is an overview. Each section links to the page with the full details.

## Recover a run now

Give the agent a checkpoint store and start `agent.recover()` once per process.
Every `intervalMs` (default 30 seconds) it lists `agent.pending()` and resumes
each interrupted run from its last checkpoint, so completed steps don't run
again.

```ts
import { createAgent, createProgressGuard } from 'lousho';
import { SqliteStore } from 'lousho/sqlite';

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
import { createAgent, createProgressGuard } from 'lousho';

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

## Propose edits for later

`improveAgent()` from `lousho/improve` looks for better instructions and skills
using failing cases you give it. It's experimental.

```ts
import { createAgent } from 'lousho';
import { formatImproveResult, improveAgent, renderTranscript } from 'lousho/improve';

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

- **It only returns a proposal.** An `outcome` of `proposal` comes with a `diff`.
  A person reviews it, with `formatImproveResult()` for a readable card, and
  applies it by hand.
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

From the command line, `lousho improve <agent> --check <module>` does this and prints the proposal for review; see [CLI](./cli.md#lousho-improve).

See [Improving an agent](./improve.md) for the gate, the outcomes and the safety
notes.

## How the layers fit together

A run the first layer gives up on, quarantined or stopped with
`LOUSHO_RUN_NO_PROGRESS`, is a sign that something in the agent needs to change.
Fix the tool, or change the instructions. If the cause is in the instructions or
skills, those failures can become cases for `improveAgent()`, and a person
decides whether to apply what it proposes.
