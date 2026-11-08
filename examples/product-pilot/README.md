# product-pilot

Phase W0 of agent products. It tests one question: does a **product** (a lead
agent that delegates to specialist **page** agents) beat **one flat agent** on
the same coding work? It uses no SDK changes. The product is a plain agent
directory with nested `subagents/`, and the house rules are copied by hand into
each page. A shared layer comes later, in W2.

## What runs

| Arm | What it is |
| --- | --- |
| `flat` | The heal-benchmark coding agent as it is: the same instructions, the same six tools (`read_file`, `list_dir`, `grep`, `edit_file`, `write_file`, `run_tests`) and 15 steps |
| `product` | `coding-product/`: a lead agent that delegates with the `task` tool to three pages, and stays in the conversation |
| `flat-plus` | Optional. The flat agent plus the house rules and all three page skills, with no routing. It tells you whether a product win comes from routing or from the extra page content |

| Page | Tools | Why it exists |
| --- | --- | --- |
| `investigate` | read, list, grep, run_tests | The cases fail on root causes in shared helpers, on other callers and on conventions the bug report doesn't mention. This page finds them before anything changes |
| `fix` | all six | The only page that writes. It gets the root cause, the files and the edge cases |
| `review` | read, list, grep, run_tests | Hidden tests check edge cases, conventions and other callers. This page checks the same things before the lead answers |

The lead has read, list, grep and run_tests, and no write tools. Together the
lead and pages have exactly the flat agent's six tools. Each page has its own
`instructions.md`, one skill and the same `## House rules` section (a test
checks that the copies match).

## Fairness

- **Same model.** Every agent in both arms uses the `--model` you pass.
- **Same tools.** The product's tools are the flat agent's tool objects,
  shared out to the lead and pages over one in-memory project.
- **Same budget.** Both arms get the same `limits.maxTokens` per run
  (`--max-tokens`, 300,000 by default). The product's pages share it with the
  lead. A run that hits it fails.
- **Same cases and checkers.** Both arms are scored by the same hidden tests,
  and a run fails if it changes a test or a file the case doesn't allow.
- **Interleaved.** For each case and repeat, the arms run back to back, and
  the arm that goes first alternates. Drift in the provider hits both arms.

The pages were written by someone who knew the cases, so they may suit them.
Run `flat-plus` if `product` wins, to see whether the routing or the content
made the difference.

## Cases

There are 24 cases over one synthetic JavaScript project. The 9 heal-benchmark
coding cases are reused unchanged (`page-count`, `csv-quotes`, `dedupe-first`,
`retry-errors`, `round-root-cause`, `invoice-rounding`, `signup-conventions`,
`add-months`, `map-limit`). There are 15 new cases in the same style:

| Kind | Cases |
| --- | --- |
| Shallow fix fails hidden edge cases | `clamp-range`, `slugify`, `chunk-remainder`, `group-by`, `format-money`, `cache-ttl`, `pick-falsy` |
| Project conventions the bug report doesn't mention | `order-totals`, `top-scores`, `merge-config` (no changed arguments), `parse-age`, `duration`, `range-step` (`ValidationError` with the right `field`) |
| Root cause in a shared helper | `percent-root-cause` |
| Tempting shared fix breaks another caller | `card-title` |

Every fixture is synthetic. No real code or captured trace is in the project.
Tests check that each case fails on the untouched project, passes with its
reference fix, and fails a shallow fix.

## Run it

```bash
npx tsx examples/product-pilot/run.ts --mock --cases page-count   # offline, shows the output format
OPENROUTER_API_KEY=... npx tsx examples/product-pilot/run.ts --model <model> --cache rows.jsonl
npx tsx examples/product-pilot/report.ts --in rows.jsonl
```

| Flag | Effect |
| --- | --- |
| `--model <id>` | The OpenRouter model for every agent in every arm. Required for a live run |
| `--arms <list>` | `flat,product` by default. Add `flat-plus` to separate routing from content |
| `--cases <list>` | Runs only these cases |
| `--repeats <n>` | 3 by default |
| `--gap-ms <n>` | Waits before every model call, pages included. 3500 by default |
| `--max-tokens <n>` | The token ceiling per run, the same for every arm |
| `--cache <file>` | Appends a JSONL row per run (`arm`, `case`, `repeat`, `passed`, `tokens`, `costUsd`, `modelCalls`, `model`, `date`) and skips runs already scored there, so a stopped run resumes |

A provider error (a rate limit, for example) is recorded with `passed: null`,
left out of the score, and run again on resume. A page that crashes reaches
the lead as a failed `task` call rather than an error, so such a run is
recorded the same way (`ended: 'page-error'`). Otherwise a provider error
would count against the product but not against the flat agent. `report.ts` takes `--in`,
`--model` (when a file holds more than one), `--k` and `--json`.

A full run is 24 cases × 3 repeats × 2 arms = 144 runs. Expect about 8 model
calls for a flat run and about 20 to 25 for a product run, so about 2,000
requests in total, or about 2,600 with `flat-plus`. On a free tier with a
daily cap, run it over several days with the same `--cache`.

## Go/no-go

The report compares `product` with `flat` over the cases every arm finished 3
times:

- **pass^3** is the share of cases where all 3 runs passed.
- **cost ratio** is the product's mean cost per run divided by the flat
  agent's, in USD when every run has a price, and in tokens otherwise.

**GO** if the product's pass^3 is at least the flat agent's **and** its cost is
at most 1.3× the flat agent's. Otherwise **NO-GO**.

**Stop rule:** on NO-GO, the routing part of products is dropped. The main
agent and page routing are not built. Only page labels in traces (W1) and
page-scoped healing (W3) go ahead, as an "agent groups" feature.

## Test it

```bash
npx vitest run examples/product-pilot
```
