---
description: improveAgent proposes tested edits to an agent's instructions and skills; the self-healing loop (healOnce, lousho improve) gates them, replays them, applies or queues them, and rolls them back on a regression.
---

# Improving an agent

Lousho can edit an agent's instructions and skills from its own failed runs.
There are two parts:

- **`improveAgent()`** looks for a better set of instructions and skills using
  failing cases you give it, and tests it against the current one. It only
  returns a proposal and writes nothing.
- **The self-healing loop** (`healOnce()`, `lousho improve <dir>`,
  `lousho improve <dir> --watch`) runs `improveAgent()` on an agent directory's
  failed runs, replays the winner on fresh runs, and then **applies it by
  default** (auto mode). In manual mode it queues the proposal for a person.
  `lousho improve --dry-run` writes nothing. See
  [The self-healing loop](#the-self-healing-loop).

Neither can change tools, permissions, limits or code: only `instructions.md`
and `skills/<name>/SKILL.md`.

**To stop it**, run `lousho improve pause <dir>` (it writes
`.lousho/improve.stop`), set `LOUSHO_IMPROVE=off`, or set `"enabled": false` in
`improve.json`. Any one of them stops every cycle before it starts and between
steps. To undo the last change, run `lousho improve rollback <dir> --by <name>`.
To keep a person in the loop, set `"approval": "manual"`. See
[Safety](#safety).

It's experimental: its results so far come from a small benchmark.

For how this fits with recovering failed runs while the agent serves traffic, see [Self-healing and self-improvement](./self-healing.md).

```ts
import { createAgent, defineTool } from '@linuxdevil/lousho';
import { formatImproveResult, improveAgent, renderTranscript, type Harness } from '@linuxdevil/lousho/improve';
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
console.log(formatImproveResult(result));
```

## How it works

1. It runs your cases on the current harness. If they all pass, it stops.
2. An invariant editor (how the agent works) and a domain editor (what it knows)
   each propose edits, and each proposal is run on the same cases.
   The invariant editor fixes the earliest point where a run went wrong. The
   domain editor leaves anything that would help in any profession to the
   invariant editor. The two editors run at the same time, and then so do
   their probes. Set `parallelEditors: false` to run them one after the other,
   for example on a rate-limited model.
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
not the fix. On two coding benchmark tasks, naming the wrong check always hurt:
on the harder one the editors proposed nothing in 5 of 5 tries. Naming the real
check helped on the harder task (5 of 5 proposals against 4 of 5 with no name)
and matched no name on the easier one. Name a check only when you know it.

`candidates` holds each editor's harness from before the gate, so you can review
or replay one the gate rejected.

### Several proposers

Set `proposers` (default 1, at most 4) to have k invariant and k domain editors
propose independently from the same runs, labelled `invariant-1` to
`invariant-k` and `domain-1` to `domain-k`. They run two at a time, and then so
do their probes, or one at a time with `parallelEditors: false`. Each proposal
that changes the harness is probed, and one composer reads them all. If the
composite fails the gate, each proposal that improved a training case is a
fallback, cheapest first, and one identical to an earlier proposal is not judged
again. `candidates.pool` holds every proposal, and `diversity` reports how alike
they were: `meanJaccard` is the mean pairwise overlap of their non-blank lines
(1 means identical) and `distinct` counts the different ones. As in Harness², a
proposal that changed nothing counts as a copy of the current harness.

It costs about k times the editor sessions and proposal runs of the default, so
with k = 3 a cycle runs 7 editor sessions instead of 3. Each fallback the gate
judges also costs held-out runs and maybe reruns. More fallbacks are also more
chances for noise to pass the gate: at k = 4 up to 9 harnesses can be judged,
against 3 by default, so the 15% no-op pass rate above can more than double.
Confirm a proposal with `canaryReplay` before you apply it.

### Sequential rounds

Set `mode: 'seq'` with `proposers: k` to go deep instead of wide: k rounds,
each with one invariant editor, one domain editor and a composer. Round t's
editors edit the checkpoint round t − 1's composer wrote (`compose-<t − 1>`),
not the original harness, and read every earlier round's proposals, checkpoints,
runs and notes under `context/candidates/` and `context/runs/`. The notes are
wrapped as untrusted data. The composer may merge edits across rounds, bring
back an earlier round's checkpoint or proposal, or keep the current one. Each
new checkpoint is probed, so the next round sees how it behaves. The gate then
judges every checkpoint against the original harness, never against an earlier
checkpoint, cheapest first, and the first that passes wins. A checkpoint that
changed nothing, or repeats an earlier one, is not judged again, and there is no
fallback to a single editor's harness. `candidates.pool` holds every proposal and
checkpoint, and `diversity` covers the proposals only. A round costs about what
one default cycle costs, plus `repeats` runs of each training case for its new
checkpoint, so k rounds cost about k times as much. Up to k checkpoints are
gated, each with its own held-out runs, so as with several proposers a no-op is
more likely to pass by chance: confirm with `canaryReplay`. With k = 1, `seq` is
the same as the default.

### An advisory selector

The gate is pass or fail per run, so it can't tell a clean answer from a sloppy
one that still passes the check. Set `select: true` to add a second opinion. The
gate then judges every candidate instead of stopping at the first that passes:
the composite and each proposal in the default mode, or each checkpoint in `seq`.
When two or more pass, one selector session reads each one's final answers on
the training cases and picks one. It works from these rules, in order:
delivery, conformance, fidelity, consistency, fitness and finish.

- **Blind.** The candidates are labelled A, B, … in a shuffled order, so the same
  cycle always gets the same labels. The seed is taken from the harness and the
  training and held-out case ids.
- **Safe input.** The selector sees only candidates that passed the gate, and
  never a held-out case or a run that couldn't be scored. Answers are wrapped as
  untrusted data. Return `answer` from `probe` to show the final answer;
  otherwise it reads the last assistant message of the transcript, without its
  tool calls. Each answer is cut at 4,000 characters and each candidate's file at
  about 40,000.
- **Fallback.** If the selector fails, its provider is down, or its choice isn't
  one of the labels, the cheapest candidate that passed is kept: the one with
  the fewest tokens per training run.
- **Result.** `selection` gives the label it `chosen`, its reason `why` as plain
  text, and whether it fell back (`fallback`).

The selector never overrides the gate. A harness that failed can't be chosen,
and with one passer no selector runs. Its tokens count toward `maxTokens`, and
gating every candidate costs held-out runs that stopping at the first pass would
have saved. A run that runs out of `maxTokens` while gating or selecting ends
with `budget-exceeded`, even if a candidate had already passed, so allow for
both. With `select` off, nothing changes.

## Caching and the ledger

A loop that runs every day sees the same failures again. Two caches stop it
paying twice for the same work. Both write only to a directory you choose, such
as `<agentDir>/.lousho/cache`, and use them together: an editor session is
replayed only when its evidence is byte for byte the same, and fresh probe runs
almost never are.

- **Probe runs.** Wrap your probe with `cachedProbe(probe, { dir, model })`. A
  scored run is stored under its model, `salt`, case, repeat and harness, and
  replayed with `cached: true` when the same ones come again. A run that couldn't
  be scored is never stored. Pass `distinct: true` so that a harness probed twice
  in one run, such as a composer that repeats an editor's harness, gets fresh
  runs for the gate. A replayed run is the same evidence as before, not new
  evidence, so change `salt` when you want fresh runs.
- **Editor sessions.** Set `cacheDir`. Each session is stored under a hash of its
  editor, prompt, evidence files, model, step limit and validation limits.
  `editorHooks` aren't part of the hash. A later run that would send the same
  session replays its harness and notes, with no editor call and no tokens. A
  replayed harness is validated again like a new edit, and is ignored if it
  fails. A session whose edits were dropped (`fell-back`) is never stored.

At the start of each run with `cacheDir`, entries older than 7 days are deleted,
then the oldest until the rest fit in 200 MB. Call `pruneCache(dir)` to do the
same for a probe cache elsewhere. Only cache entries are deleted, never other
files.

`ledger` counts the probe calls a run made: `planned` calls, served by `run`
(the agent ran) or `cached` (replayed), so `planned` is always `run + cached`.
`excluded` counts runs that couldn't be scored. If you wrap a cached probe in
your own function, keep its `cached` field so the run is counted as cached.

```ts
import { cachedProbe, improveAgent, type Harness, type ImproveOptions } from '@linuxdevil/lousho/improve';

declare const harness: Harness;
declare const probe: ImproveOptions['probe'];

const cacheDir = './my-agent/.lousho/cache';
const result = await improveAgent({
  harness,
  cases: ['discount-question'],
  probe: cachedProbe(probe, { dir: cacheDir, model: 'openrouter/<model>', distinct: true }),
  editor: { model: 'openrouter/<model>' },
  cacheDir,
});
console.log(result.ledger);
```

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `proposal` | Passed the gate. Review `diff` and `stages`. `improveAgent()` doesn't apply it; the [loop](#the-self-healing-loop) or `applyProposal()` does |
| `keep-base` | The editors changed nothing, or the result failed the gate. `reason` says which |
| `no-failures` | Every case passed, so no editor ran |
| `outage` | The provider failed, or no run could be scored |
| `budget-exceeded` | `maxTokens` ran out |

### Cycle outcomes

A [self-healing cycle](#the-self-healing-loop) ends with one of these in
`HealCycle.outcome`, with `reason` in plain text. The four above, other than
`proposal`, mean the same thing in a cycle.

| Outcome | Meaning |
| --- | --- |
| `idle` | Nothing to learn from: too few new failed runs (`trigger.minNewFailures`, default 3) under the current revision since the last cycle, or no failed run with a recorded input |
| `paused` | The kill switch is on. It is checked before the cycle and again before the editors, the canary and the write. Nothing was applied |
| `busy` | Another cycle holds `.lousho/cycle.lock` for this directory |
| `budget` | Today's cycles, automatic applies or tokens are used up. The counts reset at 00:00 UTC |
| `cooldown` | A rollback happened less than `cooldownHours` (default 24) ago |
| `canary-failed` | The proposal passed the gate but not the replay canary. Nothing was applied |
| `applied` | Written to the directory, and the corpus guard passed |
| `pending` | Manual mode: queued as `.lousho/proposals/<id>.json` for a person |
| `guard-rolled-back` | Applied, then the corpus guard found a regression and restored the cycle's starting revision |
| `stale` | The directory changed during the cycle, so the write was refused |
| `refused` | The writer refused the proposal, for example because it fails validation at write time or touches a read-only skill |
| `interrupted` | The cycle stopped before it finished. If it had already applied, the next cycle runs the corpus guard on that apply first |

`budget-exceeded` also covers a cycle that stops before an apply because the
corpus guard that must follow it would not fit in the tokens left, and, with
`editors.proposers` above 1, a cycle that stops before the editors run because
the last cycle's spend, scaled by k, plus its canary and guard would not fit.

## Reviewing a result

`formatImproveResult(result)` turns a result into Markdown for review: the diff, each case before and after with pass^3, the editors' notes, and flags for an edit that quotes a failed check word for word, adds text that looks like prompt injection, or adds a skill the instructions never name.

Above the diff, a Changes list shows each change on its own. A proposal's
`changes` holds the same list: each item is an `add`, `modify` or `remove` of a
line in the instructions or a skill (`skill:<name>`), or of a whole skill file
it adds or removes, with the text before and after. The list comes from the same
two harnesses as the diff, not from the editors, in order: instructions first,
then skills by name. It lines the files up in order and skips blank lines, so a
moved line shows as a remove and an add, and a change to blank lines or spacing
alone shows only in the diff.

Editors are asked for one line per change, such as
`reason: instructions: "document is forbidden": run stuck/0 kept reading it.`
A reason is attached to each change whose text contains its quoted words, which
must be at least 8 characters; when several match, the longest quote wins. The
reasons come from the composer, or from the editor whose harness passed instead.
A change with no matching reason says "no reason given". Reasons are editor text,
so the card quotes them, and they can't add sections to it. Nothing about the
gate changes: it judges the harness, not the reasons.

## Cases from your own traces

`casesFromFailures(db)` turns failed runs in your local trace database into cases. `protectedCasesFromPasses(db, traceIds)` turns good runs into protected cases. You must supply the check that scores an answer, through `probeCapturedCases`. Admit protected cases with `admitProtectedCases` before they gate: only a case that passed 6 of 6 fresh runs can join. Use only your own agents' traces, and keep them local.

`db` is your observe database (default `~/.lousho/observe.db`), opened with `new DatabaseSync(path)` from `node:sqlite`; it matches the exported `SqlDatabase` type. Build each transcript your `runCase` returns with `renderTranscript`, so tool results reach the editors marked as untrusted.

A `CaseCheck` returns `true`, `false`, `null` when it can't score the answer, or `{ passed, failure }`. Return `failure` on a failed answer to name the check it missed, as a custom `probe` does: each editor reads it in that run's record, after `Result: failed`, on one line with forged untrusted markers removed. A check must be synchronous; any other return value throws a `ConfigurationError`. Without it, a failed run whose answer looks right gives the editors nothing to fix. Name the real check; a wrong name is worse than none. A `failure` on a passed answer is dropped.

```ts
import type { CaseCheck } from '@linuxdevil/lousho/improve';

declare function failedTests(input: string, answer: string): string[];

const check: CaseCheck = (input, answer) => {
  const failed = failedTests(input, answer);
  return failed.length === 0 ? true : { passed: false, failure: failed.join('; ') };
};
```

### Recovery forks as evidence

With `retryWithDiagnosis`, [`agent.recover()`](./self-healing.md#recover-a-run-now) forks a run that kept failing into a `<id>.heal` session told why it failed. When that fork passes, you hold a pair on the same input: the failed run and a retry that passed. `casesFromRecoveries(db, filter)` finds those pairs in your local database and returns the failed runs as cases, each with a `recovery`: the retry's transcript, rendered with `renderTranscript`, the diagnosis it was given, and its final answer. A fork counts only when it carries the diagnosis and finished with no recorded error, no answer cut short and no low score. That isn't your check, so score each `recovery.answer` with your `CaseCheck` and keep only the ones that pass, then pass them on as `recoveries`:

```ts
import { casesFromRecoveries, improveAgent, type CaseCheck, type Harness, type ImproveOptions, type SqlDatabase } from '@linuxdevil/lousho/improve';

declare const db: SqlDatabase;
declare const harness: Harness;
declare const probe: ImproveOptions['probe'];
declare const check: CaseCheck;

const passes = (input: string, answer: string) => {
  const verdict = check(input, answer);
  return (verdict !== null && typeof verdict === 'object' ? verdict.passed : verdict) === true;
};
const cases = casesFromRecoveries(db, { since: Date.now() - 7 * 86_400_000 });
const result = await improveAgent({
  harness,
  cases: cases.map((c) => c.id),
  recoveries: cases.flatMap((c) => (c.recovery && passes(c.input, c.recovery.answer) ? [c.recovery] : [])),
  probe,
  editor: { model: 'openrouter/<model>' },
});
```

Each editor reads a recovery as `context/recoveries/<case>.md`, labelled as a retry that passed after this diagnosis, with the diagnosis between untrusted markers and forged markers removed. A recovery is evidence only. It's never a run: the case is still scored by your `CaseCheck`, and the gate never counts the retry. It never makes a case protected either. Every recovery must name a training case, and its `traceId` must not be a held-out case's trace, so nothing held out reaches the editors. When the loop retried a run several times before forking, the pair uses the latest of those failed runs that `casesFromFailures` captured (at most 5 per failure class).

### A library of lessons

A library keeps lessons from earlier attempts, so later editors can read them. Each lesson is one line each of cue, lesson and evidence, with the outcome it came from. A lesson is written by a model, so the library treats it as untrusted wherever it's stored or shown. `addEntry(dir, entry, { failedChecks })` stores a lesson under `<dir>/.lousho/library/<domain>/entries/`, or returns why it refused one. It refuses text that:

- trips the prompt-injection heuristics;
- carries an untrusted marker, a URL or bare domain, an email address, a Markdown link or image, HTML, hidden characters, or a word mixing Latin with lookalike letters;
- goes over 200 characters for the cue, 600 for the lesson or 400 for the evidence;
- quotes one of the cycle's failed checks.

`libraryFiles(dir, domain)` returns up to 20 active lessons as files under `context/library/`, highest-voted first, then newest. Each file is labelled as data with the lesson between untrusted markers, and you pass them to `improveAgent` as `library`. Entries are checked again when read, so an entry file edited by hand that no longer passes is skipped. `voteEntry(dir, id, 'helped' | 'hurt')` counts an outcome, and retires a lesson for good once its hurt votes outnumber its helped votes by two. Votes are appended to `votes.jsonl` next to the entries, so votes cast at once aren't lost. `improveAgent` accepts only files shaped like `libraryFiles` output, named `context/library/<name>.md`.

```ts
import { improveAgent, libraryFiles, libraryHome, type Harness, type ImproveOptions } from '@linuxdevil/lousho/improve';

declare const harness: Harness;
declare const probe: ImproveOptions['probe'];

const home = libraryHome('./agents/support');
const result = await improveAgent({ harness, cases: ['stuck'], probe, editor: { model: 'openrouter/<model>' }, library: libraryFiles(home.dir, home.domain) });
```

`libraryHome(agentDir)` keeps a library per agent, named after its directory. `libraryHome(agentDir, domain)` shares one library in the parent directory with the other agents there that name the same domain. Library text reaches the harness only through an editor's edit, which still passes every check.

### Reflecting on a decided cycle

Once a cycle is decided, `reflect` turns it into at most one lesson. A cycle is decided when its edit was kept, rejected, or applied and then rolled back. A rejected or rolled-back edit teaches as much as a kept one. The reflection session reads four files and nothing else: the review card, the diff, the case verdicts and the outcome. It never sees a raw transcript, and the text that models wrote reaches it between untrusted markers. It replies with an `<experience>` block (cue, lesson, evidence, confidence) or `NO_ENTRY`, and the lesson goes through `addEntry` with the cycle's failed checks, so a refused lesson is reported and never stored. `reflect` never throws. A failure comes back as `error` for you to record, and `tokens` is what it spent, to count toward the cycle's budget, which `maxTokens` caps.

```ts
import { libraryHome, reflect, voteOnOutcome, type ImproveResult } from '@linuxdevil/lousho/improve';

declare const result: ImproveResult;

const home = libraryHome('./agents/support');
const reflection = await reflect({ ...home, result, outcome: 'kept', revision: 'rev-12', editor: { model: 'openrouter/<model>' }, maxTokens: 50_000 });
voteOnOutcome(home.dir, { outcome: 'rolled-back', result, domain: home.domain, entryId: reflection.entry?.id });
```

Editors that used a lesson cite its id (`lib-…`) in their notes, and `citedEntries(notes)` finds those ids. Once an applied edit's fate is known, `voteOnOutcome` votes on up to three entries the winning editor cited, counting only entries in the library's domain and, when you pass the editors' `library`, only entries they were shown. Those entries get a helped vote when the edit is kept and a hurt vote when it's rolled back. Call it once per cycle: each call casts new votes. On a rollback, the cycle's own entry also gets a hurt vote, but only if it was written as `kept`. A lesson written about the rollback is left alone.

The session never sees a held-out case's id: each held-out case appears as `held-out case 1`, `held-out case 2` and so on. A reply that isn't exactly one `<experience>` block stores nothing. That covers several blocks, a repeated field, a line that isn't a field, and a block alongside `NO_ENTRY`. Nothing is stored either when the session ends early or goes over `maxTokens`.

### Live traffic canary (opt-in)

**This serves an unproven harness to real users.** It is off unless `improve.json` sets `canary.traffic` (`share` up to 0.25, `sessions` up to 50). Use it only for failures that `canaryReplay` can't replay, and run `canaryReplay` first when you can.

`startCanary` takes a proposal that passed the gate and writes `.lousho/canary.json`. While that file exists, an agent loaded with `loadAgentDir` serves the candidate to a stable share of new sessions (by a hash of the session id; a run without a session id always gets the base) and stamps those runs with the candidate's revision. The opt-in must be in `improve.json` when the agent loads. The session cap is kept in `.lousho/canary-sessions.txt`, so it holds across restarts and processes on one host.

`healOnce()` (`lousho improve`) starts it for you in auto mode. When `canary.traffic` is set, a proposal that passes the gate and the replay canary starts a traffic canary instead of being applied, and the cycle ends `canary-started`. In manual mode no candidate reaches users before a person approves it: the cycle queues the proposal as usual, and `lousho improve approve` (`approvePending(dir, id, by, { db })`) starts the traffic canary instead of applying. When that canary passes, it is applied in the approver's name without a second approval. While the canary runs, every cycle ends `busy`. `lousho improve --watch` settles the trial on each tick. A promote then counts toward `maxAppliesPerDay` and is followed by the corpus guard, and the watcher waits a day when the cap is spent. A pause ends the canary.

`settleCanary` reads the trial; call it yourself on a timer when you don't use the watcher. After `sessions` candidate sessions it promotes when the share of flagged sessions is 0 or at least 0.05 below the base's rate over its last 20 runs, and no failure class appeared that the base didn't have. It retires early once a promotion is ruled out, and when the directory changed, the loop is paused, the opt-in is removed or `monitor.giveUpDays` pass. A promote goes through `applyProposal`, which checks the proposal again. A canary started in auto mode is queued for a person instead when `improve.json` has since switched to manual. In manual mode, `startCanary` refuses without `approvedBy`, and a canary without an approver serves no one.

```ts
import { loadImproveSettings, settleCanary, startCanary, type Harness, type ImproveResult, type SqlDatabase } from '@linuxdevil/lousho/improve';

declare const db: SqlDatabase;
declare const result: ImproveResult;
declare const base: Harness;

const settings = loadImproveSettings('./agents/support');
await startCanary(db, './agents/support', { result, base }, settings);
const settled = await settleCanary(db, './agents/support', settings);
```

Deleting `.lousho/canary.json`, `stopCanary`, the `.lousho/improve.stop` file, `LOUSHO_IMPROVE=off` or `"enabled": false` stops it on the next run. A session that already started on the candidate keeps the candidate's instructions in its history.

## The self-healing loop

The loop turns an agent directory's failed runs into an applied edit, checks
it again after the write, and undoes it when it hurts. One **cycle** runs per
agent directory at a time. `lousho improve <dir>` runs one cycle, a
[watcher](#running-it-continuously) runs them on a timer, and a score
regression seen by the observe daemon can start one. Each cycle is saved as
`.lousho/cycles/<id>.json`.

A cycle runs these steps in order:

1. **Preconditions.** The kill switch is off. The cycle takes
   `.lousho/cycle.lock`, so a second cycle on the same directory ends `busy`.
   If the last cycle applied an edit and stopped before its corpus guard, that
   guard runs first. No cooldown after a rollback is active, and today's caps
   aren't used up. The approval mode comes from `--approval`, then
   `LOUSHO_IMPROVE_APPROVAL`, then `improve.json`, and defaults to `auto`.
2. **Detect.** A watcher's cycle waits until `trigger.minNewFailures` (default
   3) new failed runs have arrived under the current revision since the last
   cycle. A `lousho improve` cycle and a cycle started by a score regression
   don't wait.
3. **Capture.** Failed runs of the **current harness revision** in your local
   observe database become cases, through `casesFromFailures`. Runs of earlier
   revisions are left out, since the edit they would argue for may already be
   in. In auto mode only a failure seen in two or more runs counts
   (`trigger.requireRecurring`); a score-regression cycle takes any failed or
   low-scored run. Runs already in the corpus are left out. Runs you
   `protect` join the corpus once they pass 6 of 6 fresh runs.
4. **Propose and gate.** `improveAgent()` runs with every corpus case as a
   held-out case, the library's lessons as untrusted data, the editor cache in
   `.lousho/cache`, and the tokens left in the cycle as `maxTokens`. In auto
   mode an edit that quotes a failed check is rejected; in manual mode it is
   kept and flagged on the card.
5. **Canary.** `canaryReplay` runs each training case and each corpus case
   `canary.replayRuns` times (default 6) under the proposal, with repeat
   numbers the gate never used. Each training case must pass at least 5 of 6.
   A corpus case that passes fewer than 5 of 6 is run under the current
   harness too, and fails the canary if it does 2 or more runs worse. A case
   with fewer than 4 scored runs fails the canary.
6. **Decide.** In auto mode the proposal goes to `applyProposal()`. In manual
   mode it is saved as `.lousho/proposals/<id>.json` and the cycle ends
   `pending`. `improve.json` is read again just before this step: switching it
   from `auto` to `manual` during a cycle queues the proposal instead, and
   switching on the kill switch stops the cycle with nothing applied.
7. **Apply.** The writer changes only the `instructions.md` and
   `skills/<name>/SKILL.md` files that differ, all or nothing. It refuses when
   the directory changed since the cycle read it (`stale`), and checks the
   edit again for prompt injection. It saves the revisions before and after
   under `.lousho/revisions/` and writes one `apply` audit entry. New runs
   carry the new `lousho.harness.revision`.
8. **Corpus guard.** Every corpus case runs `guard.runs` times (default 3)
   under the new revision, with a rerun on a drop. On a regression, or when
   the guard can't run or can't judge, the edit is rolled back to the revision
   the cycle started from, and the cycle ends `guard-rolled-back`.
9. **Reflect.** When a proposal is rejected, fails the canary, is refused or is
   rolled back by the guard, a reflection session writes at most one lesson to
   the library.
10. **Audit.** Every step that changes something appends a line to the
    hash-chained `.lousho/audit.jsonl`.

Ctrl-C, or aborting `signal`, stops a cycle between steps. Once a write has
started, the apply and its corpus guard always finish.

After the cycle, a watcher keeps checking the applied edit on real traffic.
See [The monitor](#the-monitor).

`healOnce()` runs one cycle from code. `runCase` replays one recorded input
under a harness; `lousho improve` builds it for you.

```ts
import { healOnce, loadImproveSettings, type CaseCheck, type HealOptions, type SqlDatabase } from '@linuxdevil/lousho/improve';

declare const db: SqlDatabase;
declare const check: CaseCheck;
declare const runCase: HealOptions['runCase'];

const dir = './agents/support';
const cycle = await healOnce({ dir, db, check, runCase, editor: { model: 'openrouter/<model>' }, settings: loadImproveSettings(dir) });
console.log(cycle.outcome, cycle.reason);
```

`HealOptions` also takes `trigger` (`failures`, the default, `score` or
`manual`), `agent`, `since`, `protect`, `withRecoveries`, `maxTokens` (within
the daily caps), `editorHooks`, `editorTimeoutMs` (default 600000), `reflect`
(default `library.enabled`) and `signal`. `healOnce()` doesn't run the monitor;
a watcher does.

Only an agent directory whose instructions live in `instructions.md` and whose
skills live in `skills/<name>/SKILL.md` can be changed. A skill folder that
holds other files is read-only. `lousho improve` turns any other target, such as
an agent module or instructions from the prompt registry, into a dry run.

### Files on disk

Everything the loop keeps lives in the agent directory:

| Path | What it holds |
| --- | --- |
| `improve.json` | Settings; check it in with the agent |
| `.lousho/revisions/<id>.json` | One snapshot per revision, never changed |
| `.lousho/audit.jsonl` | The append-only, hash-chained audit log |
| `.lousho/cycles/<id>.json` | One record per cycle that got past the trigger |
| `.lousho/proposals/<id>.json` | Proposals waiting for a person (manual mode) |
| `.lousho/corpus.json` | Protected and fixed cases the guard replays (at most `guard.maxCases`) |
| `.lousho/library/<domain>/` | Lessons and their votes |
| `.lousho/cache/` | Editor sessions the loop can replay |
| `.lousho/state.json` | The cooldown, the monitor's verdict and the watcher's counters |
| `.lousho/improve.stop` | The kill switch, when it exists |
| `.lousho/canary.json` | The running traffic canary, when there is one |
| `.lousho/canary-sessions.txt` | Hashed ids of the sessions the traffic canary served |

Only cycles that got past the trigger are saved, so an `idle`, `paused`, `busy`,
`budget` or `cooldown` result costs nothing and isn't counted against
`budget.maxCyclesPerDay`.

## Approval modes

Both modes run the same gate and canary. They differ in who writes.

| | `auto` (default) | `manual` |
| --- | --- | --- |
| Gate and replay canary | Run | Run |
| Write | Right after the canary passes | Only on `lousho improve approve <dir> <id> --by <name>` |
| An edit that quotes a failed check | Sent back to the editor once, then dropped | Kept and flagged on the card |
| Failures that become cases | Only those seen in two or more runs (`requireRecurring` defaults to `true`) | Every one (`requireRecurring` defaults to `false`) |
| Daily cap on applies | `budget.maxAppliesPerDay` (default 1) | None; a person decides |
| A stale proposal | Refused; the cycle ends `stale` | Refused at approve time and marked stale |
| Corpus guard after the write | Right away, in the cycle | Right after `approve`, which rolls back to the approved revision's parent on a regression; with `--no-guard`, at the watcher's next scheduled guard |
| Monitor and automatic rollback | Yes, in a watcher | Yes, in a watcher |
| Traffic canary (`canary.traffic`) | Starts right after the replay canary; a pass is applied | Starts only on `approve`; a pass is applied as that approval |

Set the mode with `"approval"` in `improve.json`, `LOUSHO_IMPROVE_APPROVAL`, or
`--approval` (flag first, then the variable, then the file). Automatic rollback
stays on in manual mode too, because it only returns to a revision that was
already checked. Turn it off with `"monitor": { "autoRollback": false }`.

In manual mode, a person works the queue:

```bash
npx @linuxdevil/lousho improve pending ./my-agent
npx @linuxdevil/lousho improve pending ./my-agent --show 3f9c0a1b2d4e
npx @linuxdevil/lousho improve approve ./my-agent 3f9c0a1b2d4e --by ali --check ./check.mjs
npx @linuxdevil/lousho improve reject ./my-agent 3f9c0a1b2d4e --by ali --reason "too broad"
```

`approve` runs the corpus guard right after the write, so it needs `--check`
when the corpus has cases (or `--no-guard` to skip it). `approvePending()`,
`rejectPending()` and `listPending()` do the same from code, and
`guardApproval(dir, applied, { probe, runs })` runs that guard on what
`approvePending()` returned. See [CLI](./cli.md#pending-proposals-manual-mode).

## Running it continuously

`--watch` keeps the loop running on one agent directory:

```bash
npx @linuxdevil/lousho improve ./my-agent --check ./check.mjs --watch --interval 15m
```

Every `--interval` (default 15 minutes) a tick:

1. Reads `improve.json` again and checks the kill switch. A paused tick is
   audited once as `pause`, posts `improve.paused`, ends any traffic canary,
   and does nothing else.
2. Takes the one-watcher lease in `.lousho/watch`, which lasts two intervals
   and is renewed while the tick runs. A tick that can't take it skips.
3. Runs [the monitor](#the-monitor) on the last apply.
4. When the monitor has kept an edit, the lessons the winning editor cited get
   a helped vote, and the training cases it fixed join the corpus once they
   pass 6 of 6 fresh runs. When it rolled one back, they get a hurt vote.
5. Every `guard.everyHours` (default 24), replays the corpus under the current
   revision. On a regression it rolls back to the last good revision: the
   newest one whose latest guard passed, else the first baseline.
6. Settles a running [traffic canary](#live-traffic-canary-opt-in). A promote
   counts toward `budget.maxAppliesPerDay` and is followed by the corpus guard;
   when the cap is spent, the canary waits for the next day.
7. Runs one cycle within the daily caps. A tick that sees the same failures as
   the last cycle, and no new failed run or score regression, skips the cycle.
   While a traffic canary runs, the cycle ends `busy`.

`--watch` needs an agent name to find the agent's runs: `--agent`, or the name
the agent sets. Editor and reflection calls are limited to `rateLimit.rpm` per
minute (default 20). Three cycles in a row that end in a provider outage write
the stop file. Ctrl-C or SIGTERM stops the watcher after the current step and
releases the lease. While it runs, the watcher lists itself in `watchers.json`
beside the observe database.

From code, `watchAgent()` runs the same loop and `improveSchedule()` wraps one
tick as a [schedule](./schedules.md) for an agent that already uses
`schedules/`:

```ts
import { improveSchedule, loadImproveSettings, watchAgent, type CaseCheck, type HealOptions, type SqlDatabase } from '@linuxdevil/lousho/improve';

declare const db: SqlDatabase;
declare const check: CaseCheck;
declare const runCase: HealOptions['runCase'];

const dir = './agents/support';
const settings = loadImproveSettings(dir);
const watcher = watchAgent({ dir, db, check, runCase, agent: 'support', editor: { model: 'openrouter/<model>' }, settings, reloadSettings: () => loadImproveSettings(dir) });
process.once('SIGTERM', () => void watcher.stop());

export const improve = improveSchedule({ dir, db, check, runCase, agent: 'support', editor: { model: 'openrouter/<model>' }, settings, cron: '*/15 * * * *', intervalMs: 15 * 60_000 });
```

Give `improveSchedule()` an `intervalMs` that matches its `cron`, so the lease
spans two ticks.

### What starts a cycle

| Trigger | Started by | Waits for |
| --- | --- | --- |
| `failures` | A watcher tick | `trigger.minNewFailures` new failed runs under the current revision |
| `score` | A watcher tick that finds an `agent.score_regression` for the current revision | Nothing. Any failed or low-scored run of the revision counts, recurring or not |
| `manual` | `lousho improve <dir>` | Nothing |

The observe daemon records every `agent.score_regression` in its database, with
or without webhooks, and a watcher reads them each tick. Every budget, the
cooldown and the kill switch still apply. See
[Continuous score](./observability.md#continuous-score) for when the daemon
calls a drop a regression.

### The monitor

The corpus guard only checks cases you already have. The monitor checks real
traffic. On each tick it compares the agent's finished runs under the applied
revision with its runs under the revision before the apply, using the
[continuous score](./observability.md#continuous-score):

- It waits for `monitor.minRuns` runs on each side (default 20).
- It looks at most three times, at 1, 2 and 3 times `monitor.window` runs
  after the apply (20, 40 and 60 by default). An edit with no drop at the first
  look is kept. A drop that isn't significant yet waits for the next look, and
  the third look decides.
- A regression is a pass-rate drop of more than `monitor.maxDrop` (default
  0.05) that is significant at a per-look z of 2.1, which keeps the overall
  false rollback rate under one-sided 5%. For scores that aren't just pass or
  fail, a fall in the mean of more than `maxDrop` that the trajectory gate
  confirms also counts.
- On a regression it rolls back to the revision before the apply, audits the
  rollback, and starts a `cooldownHours` cooldown (default 24). With
  `autoRollback: false` it reports `regressed` and posts `improve.guard_failed`
  instead.
- After `monitor.giveUpDays` (default 7) without enough runs, the edit is
  `kept-unverified`, which is audited. `lousho improve status` warns about it,
  since an agent with this little traffic may be better off in manual mode.
- When the directory was edited by hand after the apply, the monitor leaves it
  alone.

`checkApplied(db, dir, settings, { agent })` runs one check from code.

## Settings

`improve.json` beside the agent holds the loop's settings. Every key is
optional, and an unknown key or a bad value stops the loop with
`LOUSHO_CONFIG_INVALID`. `loadImproveSettings(dir)` reads it.

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the loop off, like the stop file |
| `approval` | `auto` | `auto` or `manual` |
| `budget.maxTokensPerDay` | 2,000,000 | Tokens all cycles, guards and admissions may spend in a UTC day |
| `budget.maxTokensPerCycle` | unset | Tokens one cycle may spend |
| `budget.maxCyclesPerDay` | 4 | Cycles per UTC day |
| `budget.maxAppliesPerDay` | 1 | Automatic applies per UTC day; approvals aren't counted |
| `trigger.minNewFailures` | 3 | New failed runs that start a watcher's cycle |
| `trigger.requireRecurring` | `true` in auto, `false` in manual | Only failures seen in two or more runs become cases |
| `canary.replayRuns` | 6 | Fresh runs per case in the replay canary |
| `canary.traffic` | unset | `{ share, sessions }` turns on the live traffic canary (`share` at most 0.25, `sessions` at most 50): a proposal that passes the replay canary is trialled on real sessions instead of being written. See [Live traffic canary](#live-traffic-canary-opt-in) |
| `monitor.minRuns` | 20 | Runs on each side before the monitor judges |
| `monitor.window` | 20 | Runs per look |
| `monitor.maxDrop` | 0.05 | The drop that counts as a regression |
| `monitor.autoRollback` | `true` | Roll back on a regression, in both modes |
| `monitor.giveUpDays` | 7 | Days before an edit with too few runs is kept unverified |
| `guard.runs` | 3 | Runs per corpus case in the guard |
| `guard.everyHours` | 24 | Hours between a watcher's scheduled guards |
| `guard.maxCases` | 30 | Corpus size; the oldest fixed cases go first, protected cases are never dropped |
| `cooldownHours` | 24 | Hours without cycles after a rollback |
| `rateLimit.rpm` | 20 | A watcher's editor and reflection calls per minute |
| `library.enabled` | `true` | Use the lesson library and reflect after a decided cycle |
| `library.domain` | unset | Share lessons with the other agents in the parent folder that set the same domain |
| `editors.proposers` | 1 | k invariant and k domain editors per cycle, or k rounds in `seq` mode (at most 4) |
| `editors.mode` | `agg` | `agg` or `seq` |
| `editors.select` | `false` | Gate every candidate and let the advisory selector choose |
| `editors.parallel` | `true` | Run the editors and their probes two at a time |

The JSON form is in [CLI](./cli.md#improvejson).

## Notifications

A watcher posts each change to the `alerts.json` webhooks beside the observe
database, and writes one line to stderr:

| Event | When |
| --- | --- |
| `improve.applied` | A cycle applied an edit and the corpus guard passed, or a traffic canary was promoted and applied |
| `improve.pending` | A cycle or a promoted traffic canary queued a proposal; `details.card` is the proposal file's local path |
| `improve.canary` | A proposal failed the replay canary, a traffic canary started, or a traffic canary was retired |
| `improve.rolled_back` | The corpus guard or the monitor rolled an edit back |
| `improve.guard_failed` | The monitor or a scheduled guard saw a regression and didn't roll back, because `autoRollback` is off or the rollback was refused. Posted once per revision |
| `improve.paused` | The kill switch is on, or three outages in a row paused the loop |

`details` holds `{ agent, dir, from, to, reason, cycle }`, and the reason is
plain text. A failed webhook never fails a tick. A single `lousho improve`
cycle posts nothing; it prints its outcome. See
[Observability](./observability.md#the-observe-daemon).

`lousho improve status <dir> [--json]` shows the mode, the active revision, the
last audit entries, the pending proposals, the monitor's verdict, what is left
of today's budget, the cooldown, the kill switch and the last canary.
`improveStatus(dir)` returns the same from code.

## Harness² options

`improveAgent()` has the options that match Harness²:

| Option | Default | What it does |
| --- | --- | --- |
| `proposers` | 1 | k invariant and k domain editors (at most 4). See [Several proposers](#several-proposers) |
| `mode` | `agg` | `seq` runs k rounds instead. See [Sequential rounds](#sequential-rounds) |
| `select` | `false` | A blind selector among harnesses that passed the gate. See [An advisory selector](#an-advisory-selector) |
| `parallelEditors` | `true` | Run the editors, and then their probes, at the same time |
| `quotedChecks` | `reject` | `flag` keeps an edit that quotes a failed check and flags it on the card |
| `cacheDir` | unset | Replay editor sessions. See [Caching and the ledger](#caching-and-the-ledger) |

In a cycle, `quotedChecks` follows the approval mode and `cacheDir` is
`.lousho/cache`. The other four come from `settings.editors`, the `editors`
block in `improve.json` (`proposers`, `mode`, `select`, and `parallel` for
`parallelEditors`), which `healOnce()`, `watchAgent()` and `lousho improve`
pass to `improveAgent()`. A watcher re-reads them each tick when it has
`reloadSettings`, as `lousho improve --watch` does. The flags `--proposers
<1-4>` and `--mode agg|seq` win over the file, `--select` turns the selector
on and `--no-parallel-editors` turns parallel off. `lousho improve status`
shows the values in the file, with the defaults filled in. The defaults are unchanged: one proposer of each kind,
in parallel, with no selector.

k proposers cost about k times the editor sessions and proposal runs. With k
above 1, a cycle estimates its spend before the editors run: the last cycle's
`improveAgent()` tokens, divided by its proposers and multiplied by k, plus that
cycle's canary and guard tokens. If that is more than the tokens left, the cycle
ends `budget-exceeded` and nothing runs. The first cycle has nothing to scale
from, so only `maxTokens` stops it.

## From the command line

```bash
npx @linuxdevil/lousho improve ./my-agent --check ./check.mjs
npx @linuxdevil/lousho improve ./my-agent --check ./check.mjs --dry-run --since 7d --out proposal.md
```

On an agent directory, `lousho improve` runs one self-healing cycle with
`healOnce()`. In auto mode it **applies** a proposal that passes the gate and
the canary, and in manual mode it queues it. With `canary.traffic` set, auto
mode starts the [traffic canary](#live-traffic-canary-opt-in) instead. It needs a module whose default
export is your `CaseCheck` (return `failure` to name the check a failed answer
missed). It reads cases only from your local observe database, simulates tools
other than loading skills unless `--read-only` names them, and prints the review
card and the cycle's outcome.

`--dry-run` keeps the old behaviour: it reads every failed run whatever its
revision, prints the card, and writes nothing. It ignores the kill switch and
the daily caps. An agent module, or an agent whose instructions don't live in
`instructions.md`, always runs dry.

`--max-tokens <n>` caps one cycle, within `improve.json`'s caps; without it only
those caps apply. It is checked after each run or editor call, so the last one
can go over, and a cycle that hits it ends `budget-exceeded`.
`--with-recoveries` also shows the editors each failed run's `.heal` fork whose
answer passes your check. `--watch` keeps it running. The subcommands
`revisions`, `rollback`, `audit`, `pending`, `approve`, `reject`, `pause`,
`resume` and `status` manage the history and the loop. See
[CLI](./cli.md#lousho-improve) for every flag.

## Safety

Auto-apply writes to your agent without a person. These are the limits on what
it can do, in the order an edit meets them.

**What it can change.** Only `instructions.md` and `skills/<name>/SKILL.md` in
an agent directory: adding, changing or removing a skill, and changing the
instructions. An edit may leave at most 8,000 characters of always-on
instructions. It can't change tools,
permissions, limits, models, `agent.ts`, scripts, or any other file. A skill
folder that holds anything besides `SKILL.md` is read-only. Instructions that
come from `agent.ts`, the prompt registry or `instructions/<family>.md` are never
written.

**What it learns from.** Only your own agent's runs in your local observe
database, and only runs of the revision that is live now.

**Injection defences.**

- Every run record the editors read starts with a banner saying it is data, not
  instructions, and the editors' prompt says the same. Tool results are marked
  between `<untrusted>` markers, and any marker forged inside a run, nested or
  spaced, is removed.
- Text an edit adds is checked for prompt injection, both when the editor
  writes it (with one retry) and again at write time. A failing edit is
  dropped.
- In auto mode an edit that adds the name of a failed check its editor saw is
  rejected, when the name has two or more words and the base harness doesn't
  already contain it. This keeps edits from teaching the check instead of the
  requirement.
- Lessons in the library are cleaned and length-capped when stored and read,
  shown to editors as untrusted data, and retired after bad outcomes. Library
  text reaches the harness only through an editor's edit, which passes every
  check above.
- Text from models or traces that reaches a card, a notification or the audit
  log is plain text: no links, images or HTML.

These checks are heuristics and can be beaten, which is why the checks after
them exist.

**Checks before the write.** The gate compares against fresh runs of the
current harness, judges each training case on its own, and reruns a held-out
case that drops. The replay canary then runs fresh repeats that no gate
decision used, so a lucky gate run can't carry an edit through.

**The write.** One writer, inside `applyProposal()` and `rollbackHarness()`, is
the only code that writes harness files. Nothing else in `@linuxdevil/lousho/improve` or
`lousho improve` touches them. The write is all or nothing, and it is refused
when the directory changed since the cycle read it, so a person's edit is never
overwritten.

**Checks after the write.** The corpus guard replays the protected and fixed
cases right away, after an automatic apply and after `lousho improve approve`
(unless `--no-guard`), and a watcher replays them every `guard.everyHours`. The
monitor then compares real runs before and after. Either one rolls back on a
regression.

**Rollback.** A rollback restores a saved revision through the same writer. It
makes a new revision and never rewrites history. The corpus guard in a cycle
returns to the cycle's starting revision, the guard after an approval to the
approved revision's parent, the scheduled guard to the last
revision whose guard passed, and the monitor to the revision before the apply.
A person can roll back at any time with `lousho improve rollback <dir> --by
<name> [--to <revision>]`. Every rollback, a person's too, starts the
`cooldownHours` cooldown (default 24 hours).

**Budgets.** By default, at most 1 automatic apply, 4 cycles and 2,000,000
tokens per UTC day, no cycle for 24 hours after a rollback, and 20 editor calls
a minute in a watcher. A watcher skips a cycle when nothing new has failed.
Raise or lower them in `improve.json`; with no caps there is no limit on spend.

**Kill switch.** Any one of these stops the loop: the file `.lousho/improve.stop`
(`lousho improve pause` writes it and `resume` removes it), `LOUSHO_IMPROVE=off`,
or `"enabled": false` in `improve.json`. It is checked before each cycle, before
the editors, the canary and the write, and between a watcher's steps.

**A record of everything.** Every revision is saved, every change is one line
in the hash-chained audit log (`lousho improve audit <dir> --verify` finds an
edited or removed line), and a watcher posts each change to your webhooks.

**Manual mode is one setting away** for agents where a person should approve
every edit.

What these limits don't cover:

- **A small gate can pass a useless edit.** With 1 to 3 training cases and 3
  repeats, the canary, the corpus guard and the monitor are what catch it, and
  harm on traffic the corpus doesn't cover shows only after 20 runs.
- **Agents with little traffic never get a monitor verdict.** Their edits stay
  `kept-unverified`. Consider manual mode for them.
- **A model change can look like a regression** and roll back a good edit. The
  rollback is audited, and you can apply the revision again.
- **Your `probe` or `runCase` runs the agent, so it owns side effects.** Add
  `createShadowHook({ readOnly: ['search'] })` unless every tool is safe to run:
  other calls are simulated and don't run. A simulated result can differ from a
  real one, so treat those runs as weaker evidence.
- **Editors have file tools on an in-memory workspace** and no shell or network.
- **Held-out cases never reach the editors.** Return `passed: null` for a run you
  can't score; it's excluded, not counted as a failure.
- **The review card shows links and images in model-written text as plain text.** In notes, reasons, errors, flags and cases, a link or image shows its target (`hxxps://…`), and HTML, autolinks, URLs and email addresses are escaped or defanged, so viewing the card loads nothing and can't add a section. The diff stays in a fence its text can't close. A viewer that links bare domains, such as `example.com/x`, can still link one, showing it as written.

## Notes for builders

- **A paused watcher skips the monitor too.** While the kill switch is on, a
  tick does nothing, so the monitor's automatic rollback doesn't run either.
  Roll back by hand with `lousho improve rollback` if you pause because an edit
  looks bad.
- **A single cycle doesn't monitor.** `lousho improve <dir>` and `healOnce()`
  run the corpus guard but not the monitor. Run a watcher, or call
  `checkApplied()`, to get the real-traffic check and its rollback.
- **Telegram bridges from older projects.** A `src/telegram/bridge.ts`
  generated by `npm create @linuxdevil/lousho` before 1.0.0-alpha.99 writes
  `.lousho/state.json` without the lock the loop uses for the same file. If the
  bridge and the loop share a directory, regenerate `bridge.ts` from a new
  Telegram project. The new bridge keeps its state in `.lousho/telegram.json`
  and still reads the owner from the old file.
- **A score regression with no failed or low-scored runs ends `idle`.** The
  loop has nothing to learn from until such runs arrive.
- **Older SDKs refuse a database the new daemon migrated.** The score trigger
  adds a `score_regressions` table to the observe database. A process on an
  older `@linuxdevil/lousho` then fails with `LOUSHO_STORAGE_FAILED` ("newer than this
  library supports"), so upgrade every process that shares the database.
- **`watchers.json` is informational.** The daemon records every regression
  whether or not a watcher is listed, once per agent and revision.
- **`state.json` must stay a JSON object.** If it is broken, the loop stops with
  `LOUSHO_CONFIG_INVALID` until you fix or delete it.
