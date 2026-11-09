# product-pilot

Phase W0 of agent products. It tests one question: does a **product** (a lead
agent that delegates to specialist **page** agents) beat **one flat agent** on
the same coding work? It uses no SDK changes. The product is a plain agent
directory with nested `subagents/`, and the house rules are copied by hand into
each page. A shared layer comes later, in W2.

## What runs

| Arm | What it is |
| --- | --- |
| `flat` | The heal-benchmark coding agent as it is: the same instructions and the same six tools (`read_file`, `list_dir`, `grep`, `edit_file`, `write_file`, `run_tests`) |
| `product` | `coding-product/`: a lead agent that delegates with the `task` tool to three pages, and stays in the conversation |
| `flat-plus` | One agent with the flat agent's instructions plus every page's instructions, the investigate, fix, review loop, the house rules and all three page skills. Only the routing is missing, so it tells you whether a product win comes from routing or from the page content |

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
- **Same budget.** Every arm gets the same `limits.maxTokens` per run
  (`--max-tokens`, 300,000 by default), and the product's pages share it with
  the lead. This is the ceiling that binds. Every agent, flat or lead or page,
  also gets the same `maxSteps` (`--max-steps`, 40 by default, set in code, not
  in `agent.json`). The heal-benchmark's 15 steps would cap the flat agent at
  15 model calls while each page call gets 15 of its own, so the step limit is
  set high enough not to bind. A run that hits either limit is scored, usually
  as a fail, and the report counts them per arm (`out of budget`).
- **Same cases and checkers.** Both arms are scored by the same hidden tests,
  and a run fails if it changes a test or a file the case doesn't allow.
- **Interleaved.** For each case and repeat, the arms run back to back, and
  the arm that goes first alternates. Drift in the provider hits both arms.

- **Same exclusions.** A provider error is left out of the score in every
  arm (see below). A page that runs out of steps or tokens is not an error: the
  lead carries on and the run is scored.

The pages were written by someone who knew the cases, and the flat agent's
prompt doesn't mention `docs/CONVENTIONS.md` or the scoring rules. So `flat`
vs `product` mixes routing with prompt content. `flat-plus` has the same
content without the routing, which is why it runs by default.

Every case runs in the same project, which holds all 24 bugs, so tests for
other cases fail whatever the agent does. The lead and pages are told to
ignore tests for unrelated code. The flat agent's prompt is unchanged.

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
| `--arms <list>` | `flat,product,flat-plus` by default |
| `--cases <list>` | Runs only these cases |
| `--repeats <n>` | 3 by default |
| `--gap-ms <n>` | Waits before every model call, pages included. 3500 by default |
| `--max-tokens <n>` | The token ceiling per run, the same for every arm. 300000 by default |
| `--max-steps <n>` | The step limit of every agent in every arm. 40 by default |
| `--cache <file>` | Appends a JSONL row per run (`arm`, `case`, `repeat`, `passed`, `tokens`, `costUsd`, `modelCalls`, `model`, `budget`, `date`) and skips runs already scored there with the same model and budget, so a stopped run resumes |

A provider error (a rate limit, for example) is recorded with `passed: null`,
left out of the score, and run again on resume. A page that crashes reaches
the lead as a failed `task` call rather than an error, so such a run is
recorded the same way (`ended: 'page-error'`). Otherwise a provider error
would count against the product but not against the flat agent. On resume,
left-out runs are run again in plan order, so they may run later than their
partners in the other arms; each row's `date` shows when. `report.ts` takes
`--in`, `--model` (when a file holds more than one), `--k` and `--json`, and
refuses rows that mix models or budgets.

A full run is 24 cases × 3 repeats × 3 arms = 216 runs. Expect about 8 model
calls for a flat run, about 10 for flat-plus and about 20 to 25 for a product
run, so about 3,000 requests in total (about 2,200 with `--arms flat,product`).
On a free tier with a daily cap, run it over several days with the same
`--cache`.

## Go/no-go

The report compares `product` with `flat` over the cases both finished 3
times:

- **pass^3** is the share of cases where all 3 runs passed.
- **cost ratio** is the product's mean cost per run divided by the flat
  agent's, in USD when every run has a price, and in tokens otherwise.

**GO** if the product's pass^3 is at least the flat agent's **and** its cost is
at most 1.3× the flat agent's. Otherwise **NO-GO**. A tie in pass^3 counts as
GO. With 24 cases and 3 repeats, a difference of one or two cases is within
noise, so read the per-case table before you act on a narrow result.

The report also prints a **routing check**: the same test with `flat-plus` in
place of `flat`. If the product beats `flat` but not `flat-plus`, the gain
comes from the page content, not the routing, and the content can go into one
agent instead.

**Stop rule:** on NO-GO, the routing part of products is dropped. The main
agent and page routing are not built. Only page labels in traces (W1) and
page-scoped healing (W3) go ahead, as an "agent groups" feature.

## Test it

```bash
npx vitest run examples/product-pilot
```
