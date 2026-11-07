# heal-benchmark

A repeatable way to tell whether a change to an agent's harness helped. It runs
four agents through 28 tasks and reports each harness version's pass rate,
noise, tokens and tool calls.

| Agent | What it tests |
| --- | --- |
| `support-desk` | A carrier outage, a refund that moves money, and a policy that sets the amount or refuses |
| `data-analyst` | A broken tool, a missing file, messy references, currency conversion, and incomplete data |
| `doc-qa` | A flaky service, a forbidden document, a stale document, and an answer spread over two documents |
| `coding-agent` | Bugs in a small JavaScript project: shallow fixes, a tempting fix that breaks another test, project conventions the task doesn't mention, and edge cases only hidden tests check |

Every tool fault is planted, and each check is a deterministic test of the answer
or of the tool calls made. `coding-agent` is scored by running hidden tests, and a
run fails if it edits a test or a file the task doesn't need. Treat these results
as a signal, because your own agents may behave differently.

`coding-agent` edits an in-memory copy of its project. Its tests, including any code
the model wrote, run in a temporary directory with an empty environment, under
Node's permission model. That blocks files outside the directory and child
processes. Network access is blocked only on Node 25 or later, so run live
benchmarks on Node 25 or in a sandbox of your own.

## Run it

```bash
npx tsx examples/heal-benchmark/index.ts                    # offline, shows the output format
OPENROUTER_API_KEY=... npx tsx examples/heal-benchmark/index.ts --repeats 4 --out runs.jsonl
```

Live runs use free OpenRouter models unless you pass `--model`. These flags
change what's measured:

| Flag | Effect |
| --- | --- |
| `--guard` | Adds `createProgressGuard()` |
| `--instructions "..."` | Appends to each agent's instructions |
| `--only <task>` | Runs a single task |
| `--repeats <n>` | Runs each task `n` times per model |
| `--gap-ms <n>` | Waits before each model call, for rate limits |

## Reading the scoreboard

- A new harness version comes from any change to the instructions, tool names or
  hooks.
- `noise` is the spread in pass rate between repeats. A gain smaller than the noise
  isn't evidence of anything.
- A provider failure, such as a rate limit, counts as `excluded` and never as a
  failure. Results refuse to combine if a task's input changed between runs.

## Improve and replay

`improve.ts` runs `improveAgent` on one agent's cases. `replay.ts` re-runs the harnesses it recorded.

| Flag | Effect |
| --- | --- |
| `--cache <dir>` | Stores each scored run by harness, case, repeat, model and attempt, so a replay reuses it. Offline mock runs are kept apart from live ones, and the gate never reuses a run the editors were shown |
| `--confirm-candidates` | Confirms every editor's harness, not only a proposal, with `--confirm` fresh runs. Needs `--confirm` above 0 |
| `--first-attempt <n>` | Starts numbering attempts at `n`, to continue a run on another day |

## Gate experiment

`experiment.ts` replays recorded editor outputs through four gates (A: none, B: the old gate, C: the current gate, D: the current gate with fallback), plus a no-op (N) and a planted regression (P). `simulate.ts` estimates the same rates offline from per-case pass rates.

`experiment.ts` has no default model, so pass `--model` and `--editor` every time. Before arms N and P, it checks that each `--holdout` case passes 6/6 on the base, and exits with code 2 if one doesn't. It replays only rows that ended in a proposal or kept the base. The proof run, in order:

```bash
MODEL=stealth/crouton-alpha EDITOR=stealth/crouton-alpha S=$SCRATCH/m34
npx tsx examples/heal-benchmark/simulate.ts --trials 2000
npx tsx examples/heal-benchmark/experiment.ts --admit --model $MODEL --editor $EDITOR --holdout round-root-cause --holdout page-count --cache $S/cache
npx tsx examples/heal-benchmark/improve.ts --agent coding-agent --case add-months --holdout <admitted> --model $MODEL --editor $EDITOR --attempts 2 --first-attempt <n> --repeats 3 --confirm 6 --confirm-candidates --cache $S/cache --out $S/rows.jsonl
npx tsx examples/heal-benchmark/improve.ts --agent coding-agent --case <first admitted> --holdout <second admitted> --model $MODEL --editor $EDITOR --always-propose --attempts 5 --repeats 3 --confirm 6 --confirm-candidates --cache $S/cache --out $S/healthy.jsonl
npx tsx examples/heal-benchmark/replay.ts --in $S/rows.jsonl --model $MODEL --cache $S/cache --confirm 6 --out $S/truth.jsonl
npx tsx examples/heal-benchmark/experiment.ts --in $S/rows.jsonl --truth $S/truth.jsonl --healthy $S/healthy.jsonl --model $MODEL --editor $EDITOR --cache $S/cache --attempts 10 --holdout <admitted> --out $S/arms.jsonl
```

## Test it

```bash
npx vitest run examples/heal-benchmark
```
