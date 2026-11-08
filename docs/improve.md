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

### Recovery forks as evidence

With `retryWithDiagnosis`, [`agent.recover()`](./self-healing.md#recover-a-run-now) forks a run that kept failing into a `<id>.heal` session told why it failed. When that fork passes, you hold a pair on the same input: the failed run and a retry that passed. `casesFromRecoveries(db, filter)` finds those pairs in your local database and returns the failed runs as cases, each with a `recovery`: the retry's transcript, rendered with `renderTranscript`, the diagnosis it was given, and its final answer. A fork counts only when it carries the diagnosis and finished with no recorded error, no answer cut short and no low score. That isn't your check, so score each `recovery.answer` with your `CaseCheck` and keep only the ones that pass, then pass them on as `recoveries`:

```ts
import { casesFromRecoveries, improveAgent, type CaseCheck, type Harness, type ImproveOptions, type SqlDatabase } from 'lousho/improve';

declare const db: SqlDatabase;
declare const harness: Harness;
declare const probe: ImproveOptions['probe'];
declare const check: CaseCheck;

const cases = casesFromRecoveries(db, { since: Date.now() - 7 * 86_400_000 });
const result = await improveAgent({
  harness,
  cases: cases.map((c) => c.id),
  recoveries: cases.flatMap((c) => (c.recovery && check(c.input, c.recovery.answer) === true ? [c.recovery] : [])),
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
import { improveAgent, libraryFiles, libraryHome, type Harness, type ImproveOptions } from 'lousho/improve';

declare const harness: Harness;
declare const probe: ImproveOptions['probe'];

const home = libraryHome('./agents/support');
const result = await improveAgent({ harness, cases: ['stuck'], probe, editor: { model: 'openrouter/<model>' }, library: libraryFiles(home.dir, home.domain) });
```

`libraryHome(agentDir)` keeps a library per agent, named after its directory. `libraryHome(agentDir, domain)` shares one library in the parent directory with the other agents there that name the same domain. Library text reaches the harness only through an editor's edit, which still passes every check.

### Reflecting on a decided cycle

Once a cycle is decided, `reflect` turns it into at most one lesson. A cycle is decided when its edit was kept, rejected, or applied and then rolled back. A rejected or rolled-back edit teaches as much as a kept one. The reflection session reads four files and nothing else: the review card, the diff, the case verdicts and the outcome. It never sees a raw transcript, and the text that models wrote reaches it between untrusted markers. It replies with an `<experience>` block (cue, lesson, evidence, confidence) or `NO_ENTRY`, and the lesson goes through `addEntry` with the cycle's failed checks, so a refused lesson is reported and never stored. `reflect` never throws. A failure comes back as `error` for you to record, and `tokens` is what it spent, to count toward the cycle's budget, which `maxTokens` caps.

```ts
import { libraryHome, reflect, voteOnOutcome, type ImproveResult } from 'lousho/improve';

declare const result: ImproveResult;

const home = libraryHome('./agents/support');
const reflection = await reflect({ ...home, result, outcome: 'kept', revision: 'rev-12', editor: { model: 'openrouter/<model>' }, maxTokens: 50_000 });
voteOnOutcome(home.dir, { outcome: 'rolled-back', result, domain: home.domain, entryId: reflection.entry?.id });
```

Editors that used a lesson cite its id (`lib-…`) in their notes, and `citedEntries(notes)` finds those ids. Once an applied edit's fate is known, `voteOnOutcome` votes on up to three entries the winning editor cited, counting only entries in the library's domain and, when you pass the editors' `library`, only entries they were shown. Those entries get a helped vote when the edit is kept and a hurt vote when it's rolled back. On a rollback, the cycle's own entry also gets a hurt vote, but only if it was written as `kept`. A lesson written about the rollback is left alone.

The session never sees a held-out case's id: each held-out case appears as `held-out case 1`, `held-out case 2` and so on. A reply that isn't exactly one `<experience>` block stores nothing. That covers several blocks, a repeated field, a line that isn't a field, and a block alongside `NO_ENTRY`. Nothing is stored either when the session ends early or goes over `maxTokens`.

## From the command line

`lousho improve` runs the same steps on an agent directory or module:

```bash
npx lousho improve ./my-agent --check ./check.mjs --since 7d --out proposal.md
```

It reads cases only from your local observe database, needs a module whose
default export is your `CaseCheck`, simulates tools other than loading skills
unless `--read-only` names them, and prints the review card. It applies nothing.
`--max-tokens <n>` sets `maxTokens`; it has no default, so without it there is no
cap. It is checked after each run or editor call, so the last one can go over,
and a run that hits it ends `budget-exceeded`.
`--with-recoveries` also shows the editors each failed run's `.heal` fork whose answer passes your check. See
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
- **The review card shows links and images in model-written text as plain text.** In notes, reasons, errors, flags and cases, a link or image shows its target (`hxxps://…`), and HTML, autolinks, URLs and email addresses are escaped or defanged, so viewing the card loads nothing and can't add a section. The diff stays in a fence its text can't close. A viewer that links bare domains, such as `example.com/x`, can still link one, showing it as written.
