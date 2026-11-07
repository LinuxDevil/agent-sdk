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

## Test it

```bash
npx vitest run examples/heal-benchmark
```
