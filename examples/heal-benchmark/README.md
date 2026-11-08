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

## Run `lousho improve` on the coding agent

`improve-cli/` runs `coding-agent` the way you'd run your own agent: it records
real runs to a local observe database, then `lousho improve` turns the failed
runs into cases and prints a proposal card. Nothing is applied. A person reads
the card and decides whether to change the agent's instructions by hand.

| File | What it is |
| --- | --- |
| `improve-cli/agent.ts` | The agent module `lousho improve` loads: `coding-agent` with its tools, on `openrouter/qwen/qwen3.7-flash` |
| `improve-cli/check.ts` | The `--check` module: runs the hidden tests for the case on the project the run just edited, and names the ones a failed run missed |
| `improve-cli/record.ts` | Runs the agent over chosen cases and scores each run into the database you name |

Each run starts from a fresh in-memory copy of the project. `lousho improve`
simulates tools unless `--read-only` names them, so the commands below name
all six project tools. The file tools only touch the in-memory copy.
`run_tests` runs code the model wrote, with an empty environment, under Node's
permission model in a temporary directory, so it can't read or write files
outside it. Network access is blocked only on Node 25 or later. If the tools
were simulated, the check leaves the run unscored instead of failing it.

`check.ts` scores the run the agent just made in the same process, so run one
agent at a time. A failed run returns `failure` with the real names of the
hidden tests it failed, such as `follows project conventions`, so the editors
see which check each failed run missed. Without that name the agent's fix looks
right, and the editors kept the base.

Use a paid model that may read captured traces, such as `qwen/qwen3.7-flash`,
for both the agent and the editors. `record.ts` refuses `--model`, and
`agent.ts` refuses `--model` or `--editor`, when it names `stealth/...` or
`crouton-alpha`, because those models must never see captured traces.
`lousho improve` reports the refusal as an import error of `agent.ts`.

### 1. Record runs

```bash
npm run build
mkdir -p .lousho/heal
OPENROUTER_API_KEY=... npx tsx examples/heal-benchmark/improve-cli/record.ts \
  --db .lousho/heal/observe.db --model qwen/qwen3.7-flash \
  --cases csv-quotes,invoice-rounding,signup-conventions,add-months,map-limit \
  --repeats 1 --gap-ms 1000
```

`--db` is required, so the script never writes to `~/.lousho`. The path above
is under the repo's `.lousho/`, which git ignores. The script starts
`lousho observe start --db <path>` on a free port, runs each case `--repeats`
times, scores each run `hidden-tests` 1 or 0 with `check.ts`, and stops the
collector. A score that can't be written leaves that run unscored, and the
recording goes on. The reporter keeps its identity in `.lousho/identity/` next
to the database. `--cases` takes case ids or `all` (the default), `--model`
takes the OpenRouter model with or without `openrouter/`, and `--gap-ms` waits
before each model call.

Each failed run becomes its own case, so a higher `--repeats` adds cases and
cost. Before step 2, see which runs will become cases:

```bash
node bin/lousho.js observe failures --db .lousho/heal/observe.db
```

### 2. Propose a change

```bash
OPENROUTER_API_KEY=... node bin/lousho.js improve examples/heal-benchmark/improve-cli/agent.ts \
  --check examples/heal-benchmark/improve-cli/check.ts --db .lousho/heal/observe.db --agent coding-agent \
  --model openrouter/qwen/qwen3.7-flash --editor openrouter/qwen/qwen3.7-flash \
  --read-only read_file --read-only list_dir --read-only grep \
  --read-only edit_file --read-only write_file --read-only run_tests \
  --max-tokens 8000000 --out .lousho/heal/proposal.md
```

### 3. Read the card

The card starts with `# Improve result: <outcome>`. `proposal` comes with a diff
of the instructions, the reason for each change, and the gate's verdicts. Any
other outcome, such as `keep-base` or `no-failures`, proposes nothing. `--out`
saves the same card. Nothing changes until you edit `agent.ts` yourself.

### Cost

A coding run makes about 5 to 15 model calls, which is roughly 30,000 to 80,000
tokens. The recording above is 5 runs, or about 0.25M tokens.

`lousho improve` takes up to 5 failed runs per failure class. A low hidden-test
score is one class. A run that hit a tool error or a provider error is another
class, even when its tests passed. Each case runs 3 times on the base, on each
editor's harness, on a fresh base and on the final harness, which is 15 runs a
case. With 5 cases that is 75 agent runs, or about 2M to 6M tokens, plus the
editors' calls. `--max-tokens 8000000` caps the spend. If the budget runs out,
the result is `budget-exceeded` and nothing is proposed.

At a flash model's price of about $0.10 per million tokens, the whole flow
costs about $1. Check the model's current OpenRouter price before you run it.

## Improve and replay

`improve.ts` runs `improveAgent` on one agent's cases. `replay.ts` re-runs the harnesses it recorded.

| Flag | Effect |
| --- | --- |
| `--cache <dir>` | Stores each scored run by harness, case, repeat, model and attempt, so a replay reuses it. Offline mock runs are kept apart from live ones, and the gate never reuses a run the editors were shown |
| `--confirm-candidates` | Confirms every editor's harness, not only a proposal, with `--confirm` fresh runs. Needs `--confirm` above 0 |
| `--first-attempt <n>` | Starts numbering attempts at `n`, to continue a run on another day |
| `--failure-names <real\|none\|shuffled>` | Shows editors the real failed check, none, or another task's, to test whether the name itself helps |

## Gate experiment

`experiment.ts` replays recorded editor outputs through four gates (A: none, B: the old gate, C: the current gate, D: the current gate with fallback), plus a no-op (N) and a planted regression (P). `simulate.ts` estimates the same rates offline from per-case pass rates.

`experiment.ts` has no default model, so pass `--model` and `--editor` every time. Before arms N and P, it checks that each `--holdout` case passes 6/6 on the base, and exits with code 2 if one doesn't. It replays only rows that ended in a proposal or kept the base. The proof run, in order:

```bash
MODEL=stealth/crouton-alpha EDITOR=stealth/crouton-alpha S=$SCRATCH/m34
npx tsx examples/heal-benchmark/simulate.ts --trials 2000
npx tsx examples/heal-benchmark/experiment.ts --admit --model $MODEL --editor $EDITOR --holdout page-count --holdout dedupe-first --cache $S/cache
npx tsx examples/heal-benchmark/improve.ts --agent coding-agent --case add-months --holdout <admitted> --model $MODEL --editor $EDITOR --attempts 2 --first-attempt <n> --repeats 3 --confirm 6 --confirm-candidates --cache $S/cache --out $S/rows.jsonl
npx tsx examples/heal-benchmark/improve.ts --agent coding-agent --case <first admitted> --holdout <second admitted> --model $MODEL --editor $EDITOR --always-propose --attempts 5 --repeats 3 --confirm 6 --confirm-candidates --cache $S/cache --out $S/healthy.jsonl
npx tsx examples/heal-benchmark/replay.ts --in $S/rows.jsonl --model $MODEL --cache $S/cache --confirm 6 --out $S/truth.jsonl
npx tsx examples/heal-benchmark/experiment.ts --in $S/rows.jsonl --truth $S/truth.jsonl --healthy $S/healthy.jsonl --model $MODEL --editor $EDITOR --cache $S/cache --attempts 10 --holdout <admitted> --out $S/arms.jsonl
```

## Test it

```bash
npx vitest run examples/heal-benchmark
```
