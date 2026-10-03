# Evals

Evals are regression tests for agent *behaviour*: which tools the agent called,
in what order, with which arguments, how many steps it took, and what it said.
They are written with `defineEval()`, live in `*.eval.ts` files, run under
[vitest](https://vitest.dev), and are best run in CI with `lousho eval`, which
prints a summary and writes JUnit and JSON reports.

```bash
npm install --save-dev vitest
npx lousho eval
```

## Writing a trajectory eval

Give `defineEval()` an agent (from `createAgent()`) and a `test` function. Send
messages with `t.send()`, then assert on the run. Using `mockModel` as the
agent's provider makes the eval deterministic: no network, no API key, no
flakiness. **This is the default way to write an eval**; use a real model only
for the [judge evals](#judge-evals) below.

```ts
// refund.eval.ts
import { z } from 'zod';
import { createAgent, defineEval, defineTool, includes } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by id',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'delivered' }),
});

defineEval({
  name: 'refund flow',
  tags: ['smoke'],
  // A factory builds a fresh agent (and a fresh script) for every case.
  agent: () =>
    createAgent({
      prompt: 'You handle refund requests.',
      tools: [lookupOrder],
      provider: mockModel([
        { toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }] },
        { text: 'Order 42 can be refunded within 30 days.' },
      ]),
    }),
  async test(t) {
    await t.send('Refund order 42');
    t.completed();
    t.calledTool('lookup_order', { args: { orderId: '42' } });
    t.notCalledTool('issue_refund');
    t.check('mentions policy', t.reply, includes('30 days'));
    t.maxSteps(4);
  },
});
```

`defineEval()` also still accepts the original form
(`{ name, agent, input, provider, score, threshold }`): it keeps working
unchanged, and its result shows up in `lousho eval` as one `score` assertion.

### Assertions

Every assertion is recorded; the case fails at the end and lists **every**
failed gate, so one run shows all that is wrong.

| Call | Kind | Passes when |
| --- | --- | --- |
| `t.completed()` | gate | the latest run ended with a normal `stop` (not an error, abort, pending approval, or `maxSteps` cut-off) |
| `t.calledTool(name, { args?, times? })` | gate | the tool was called; `args` is a partial deep match (the call's arguments must contain these keys with equal values); `times` is an exact count of matching calls |
| `t.notCalledTool(name)` | gate | the tool was never called |
| `t.toolOrder([a, b])` | gate | the tools were called in this order (other calls may sit in between) |
| `t.maxSteps(n)` | gate | the agent took at most `n` model steps |
| `t.maxTokens(n)` | gate | the agent used at most `n` tokens |
| `t.maxCostUsd(n)` | gate | the run's reported cost is at most `n` USD. Skipped (counts as passed, marked `skipped`) when the SDK reports no cost |
| `t.check(name, value, check)` | gate | `check` passes for `value` |
| `t.soft(name, value, check)` | soft | never fails the run (unless `--strict`); the score is recorded and reported |
| `await t.judge(rubric)` | n/a | returns a 0 to 1 score from an LLM judge (see [Judge evals](#judge-evals)) |

Checks, for `t.check()` and `t.soft()`: `includes(text)`, `matches(regex)`,
`equals(value)` (yes/no, score 1 or 0), and `atLeast(n)`, `atMost(n)` (the
number is the score).

Failure messages say what was actually seen:

```text
calledTool('lookup_order') failed: tools called were [search_docs, issue_refund]
calledTool('lookup_order', {"args":{"orderId":"41"}}) failed: 'lookup_order' was called 1 time(s) but no call matched the expected args; closest call differs in orderId: expected "41", got "42"
completed() failed: finishReason was 'max-steps' (the run hit maxSteps while still calling tools)
```

Other context members: `t.reply` (latest reply text), `t.result` (latest
`ExecutionResult`), `t.toolCalls` (every call so far, with parsed arguments).
You can `send()` more than once; steps, tokens and tool calls add up.

### Datasets

Pass `cases` and `test` runs once per case, each reported separately. A case is
any object; its `label` (or `name`, or its `input`) names it.

```ts
import { z } from 'zod';
import { createAgent, defineEval, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by id',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId }),
});

defineEval({
  name: 'order lookups',
  agent: () =>
    createAgent({
      tools: [lookupOrder],
      provider: mockModel([
        { toolCalls: [{ name: 'lookup_order', args: { orderId: '7' } }] },
        { text: 'Found it.' },
      ]),
    }),
  cases: [
    { input: 'Where is order 7?', orderId: '7' },
    { input: 'Status of #7', orderId: '7', label: 'hash syntax' },
  ],
  async test(t, c) {
    await t.send(c.input);
    t.calledTool('lookup_order', { args: { orderId: c.orderId } });
  },
});
```

Pass a **factory** (`agent: () => createAgent(...)`) so each case gets its own
agent and its own `mockModel` script. With a single shared agent, a scripted
model runs out of turns on the second case.

## Judge evals

`t.judge(rubric)` grades the latest reply with an LLM and returns a score from
0 to 1. It needs a judge provider, and lousho never calls a real LLM unless you
configured one: without `judge`, `t.judge()` throws an error saying how to fix
it.

```ts
// tone.judge.eval.ts: run with `lousho eval --judge`
import { createAgent, defineEval, atLeast } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

defineEval({
  name: 'tone',
  agent: createAgent({ provider: mockModel(['Happy to help with that refund!']) }),
  // A real provider in practice; mockModel keeps this example offline.
  judge: { provider: mockModel(['0.9']), model: 'judge-model' },
  async test(t) {
    await t.send('I want my money back');
    t.soft('polite', await t.judge('Is the reply polite?'), atLeast(0.7));
  },
});
```

Files named `*.judge.eval.ts` are never picked up by a normal run (and
`npm test`); only `lousho eval --judge` (or `npm run test:evals:judge` in this
repository) runs them.

## `lousho eval`

```text
lousho eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--record | --replay | --drift [--drift-usage]] [--url <base> [--token <bearer>]]
```

| Option | Meaning |
| --- | --- |
| `globs...` | eval files to run (default: every `**/*.eval.ts`, or `**/*.judge.eval.ts` with `--judge`) |
| `--tag t` | only run evals whose `tags` include `t` (repeat or comma-separate for several) |
| `--junit path` | write a JUnit XML report |
| `--json path` | write the summary and every structured result as JSON |
| `--strict` | soft failures fail the run |
| `--judge` | run `*.judge.eval.ts` files instead of the normal ones |
| `--url base` | run every case against the deployed agent at `base` instead of in-process; `--token` (or `LOUSHO_EVAL_TOKEN`) is the bearer token. See [Run evals against a deployment](#run-evals-against-a-deployment) |
| `--config path` | use your own vitest config instead of the generated one |
| `--record` | run against the real provider and write one cassette per case ([below](#record-replay-and-drift)) |
| `--replay` | run every case from its cassette, with no network; a missing cassette fails the case |
| `--drift` | re-record into a temp directory and report how each case's trajectory changed (`--drift-usage` also compares tokens) |

It spawns the vitest installed in your project (vitest is *your* dependency; if
it is missing the command prints `npm install --save-dev vitest` and exits 2),
then prints one row per case with its scores and duration, totals, and the gate
failures and soft failures listed separately.

**Exit code:** `1` on any gate failure (or soft failure with `--strict`, or when
vitest itself fails, for example a file that does not load), `2` when it cannot
run at all (bad arguments, vitest missing), otherwise `0`.

How results are collected: each case appends one JSON line to a file named by
the `LOUSHO_EVAL_RESULTS` environment variable, which `lousho eval` sets and
reads back. This is more robust than a custom vitest reporter: it works across
vitest versions and worker pools, and needs no module loaded from your project.

### JUnit

The report is standard JUnit: one `testsuite` per eval, one `testcase` per case.
A failed gate is a `<failure message="...">` carrying the diagnostic message; a
case that threw is an `<error>`; soft failures are `<system-out>` notes (or
failures under `--strict`).

### In CI

```yaml no-verify
# .github/workflows/evals.yml
name: evals
on: [pull_request]
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx lousho eval --junit reports/evals.xml --json reports/evals.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-reports
          path: reports/
      - uses: mikepenz/action-junit-report@v4
        if: always()
        with:
          report_paths: reports/evals.xml
```

Run `--tag smoke` on every pull request and the full set nightly; run
`--judge` only where you accept real LLM calls and their cost.

## Record, replay and drift

An eval against a real model is slow, costs money and needs a key; the same
eval on `mockModel` only tests the script you wrote. `lousho eval` sits in
between: it records each case once against the real provider through
[`recordReplay`](testing.md#record-and-replay) and replays the recording in CI.
Your eval files do not change.

```bash
npx lousho eval --record        # real provider: writes the cassettes, commit them
npx lousho eval --replay        # every case from its cassette, no network, no key
npx lousho eval --drift         # re-record and diff each case's trajectory
```

- **`--record`** runs every case with its agent's real provider and writes one
  cassette per case next to the eval file:
  `__cassettes__/<eval-name>/<case>.json` (names are slugged, for example
  `refund-flow/polite.json`; an eval without `cases` writes `default.json`).
  Give each case a unique `label` so the names stay stable. A case whose agent
  uses more than one provider (a sub-agent on another model) gets
  `<case>.2.json` and so on. The files use the normal cassette format, with
  API keys redacted; review and commit them.
- **`--replay`** never calls the model. A case with no cassette fails with
  `no cassette for "<eval> [<case>]" at ...` and the `--record` command to run;
  when the agent's requests changed, the replayed model call fails with a
  `CassetteMismatchError` naming the first difference. Plain
  `lousho eval` with `CI` set replays every case that has a cassette and runs the
  rest live; without `CI` it runs live as before.
- **`--drift`** re-records every case into a temp directory (the committed
  cassettes are not touched) and compares each with its committed cassette:
  the ordered tool names, each call's arguments (JSON-normalized, so key order
  does not count), the step count and the finish reason. Token usage changes
  on every real run, so it is compared only with `--drift-usage`. The summary
  gets a `Drift:` table (eval, case, field, committed, current); each drifted
  case gets a soft `drift` assertion, so it shows as `PASS (soft fail)` and as a
  `<system-out>` note in the JUnit report. With `--strict`, drift is a gate
  failure: the case fails, JUnit has a `<failure>`, and the run exits 1.

```text
Drift:
EVAL         CASE    FIELD  COMMITTED                     CURRENT
refund flow  polite  args   lookup_order {"orderId":"42"}  lookup_order {"orderId":"43"}
```

Run `--drift` nightly or before a model upgrade, and `--replay` (or plain
`lousho eval` in CI) on every pull request. Judges are not recorded: grade with
a real judge only in `*.judge.eval.ts` files.

How it works: the run loop sends every model call (`generate` or `stream`, from
a plain run, a streamed run, a sub-agent or an approval resume) through one
provider-interception seam, `setProviderInterceptor()` (exported from
`@lousho/build-ai-agent/testing`; `src/providers/interception.ts` in the
source). Nothing is installed by default, so the seam is
free. While a case runs under one of these modes, `lousho eval` answers it with
the provider wrapped by `recordReplay()` for that case's cassette. You can use
the seam yourself to put any wrapper at the model boundary: the interceptor gets
the run's provider and returns the one to call (it must return the same wrapper
for the same provider, and leave a provider it already wrapped alone). A
cassette failure it raises - a replay mismatch or a missing cassette - reaches
`send()` typed (`CassetteMismatchError`, `LOUSHO_CASSETTE_INVALID`), not as a
compacted provider error.

## Run evals against a deployment

The same eval file that gates CI in-process can smoke-test a deployed agent (the
[node server or Cloudflare Worker](./deployment.md#http-api)). Point `lousho eval` at its base
URL and every case runs against the deployment instead of the in-process agent:

```bash
npx lousho eval --url https://agent.example.com --token "$DEPLOY_TOKEN"   # or LOUSHO_EVAL_TOKEN
```

Each case gets its own remote session (`POST /chat { sessionId, input }`, one
session per case, shared by its `t.send()` calls) and the SSE stream is read to
`run.done`. The events become the same result an in-process run produces: tool
calls, final reply, finish reason, steps and usage. So `t.calledTool()`,
`t.completed()`, scorers, `t.judge()`, the summary and `--junit` work
unchanged. The `agent` in the file is not used; give the deployment's own model
and tools the behaviour you want to check.

- A check that needs data the stream does not carry fails and says so (for
  example `maxTokens` when `run.done` has no usage); `maxCostUsd` is reported as
  skipped when there is no cost.
- `--url` cannot be combined with `--record`, `--replay` or `--drift`
  (`LOUSHO_CONFIG_CONFLICTING_OPTIONS`): cassettes record a provider in-process.
  Score/threshold evals (`score:` form) also need an in-process provider and fail
  with the same code; use trajectory evals.
- An unreachable deployment, a non-2xx answer or a truncated stream fails that
  case with `LOUSHO_REMOTE_REQUEST_FAILED`, and `401` with
  `LOUSHO_REMOTE_UNAUTHORIZED`; the run goes on. The token is never printed or
  written to a report.

In code, pass a `target` (this overrides `agent`; `--url` overrides both):

```ts
import { defineEval, remoteTarget } from '@lousho/build-ai-agent';

defineEval({
  name: 'deployed refund flow',
  target: remoteTarget({ url: 'https://agent.example.com', auth: process.env.LOUSHO_EVAL_TOKEN }),
  async test(t) {
    await t.send('Refund order 42');
    t.completed();
    t.calledTool('lookup_order');
  },
});
```

`remoteTarget({ url, auth?, fetch? })` takes an injectable `fetch`, which is how
the SDK's own tests run the real routes in-process without a socket.
