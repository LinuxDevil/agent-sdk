# Evals

Evals are regression tests for agent *behaviour*: which tools the agent called,
in what order, with which arguments, how many steps it took, and what it said.
They are written with `defineEval()`, live in `*.eval.ts` files, run under
[vitest](https://vitest.dev), and are best run in CI with `loushy eval`, which
prints a summary and writes JUnit and JSON reports.

```bash
npm install --save-dev vitest
npx loushy eval
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
import { createAgent, defineEval, defineTool, includes } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

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
unchanged, and its result shows up in `loushy eval` as one `score` assertion.

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
completed() failed: finishReason was 'tool_calls' (the run hit maxSteps while still calling tools)
```

Other context members: `t.reply` (latest reply text), `t.result` (latest
`ExecutionResult`), `t.toolCalls` (every call so far, with parsed arguments).
You can `send()` more than once; steps, tokens and tool calls add up.

### Datasets

Pass `cases` and `test` runs once per case, each reported separately. A case is
any object; its `label` (or `name`, or its `input`) names it.

```ts
import { z } from 'zod';
import { createAgent, defineEval, defineTool } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

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
0 to 1. It needs a judge provider, and loushy never calls a real LLM unless you
configured one: without `judge`, `t.judge()` throws an error saying how to fix
it.

```ts
// tone.judge.eval.ts: run with `loushy eval --judge`
import { createAgent, defineEval, atLeast } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

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
`npm test`); only `loushy eval --judge` (or `npm run test:evals:judge` in this
repository) runs them.

## `loushy eval`

```text
loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge]
```

| Option | Meaning |
| --- | --- |
| `globs...` | eval files to run (default: every `**/*.eval.ts`, or `**/*.judge.eval.ts` with `--judge`) |
| `--tag t` | only run evals whose `tags` include `t` (repeat or comma-separate for several) |
| `--junit path` | write a JUnit XML report |
| `--json path` | write the summary and every structured result as JSON |
| `--strict` | soft failures fail the run |
| `--judge` | run `*.judge.eval.ts` files instead of the normal ones |
| `--config path` | use your own vitest config instead of the generated one |

It spawns the vitest installed in your project (vitest is *your* dependency; if
it is missing the command prints `npm install --save-dev vitest` and exits 2),
then prints one row per case with its scores and duration, totals, and the gate
failures and soft failures listed separately.

**Exit code:** `1` on any gate failure (or soft failure with `--strict`, or when
vitest itself fails, for example a file that does not load), `2` when it cannot
run at all (bad arguments, vitest missing), otherwise `0`.

How results are collected: each case appends one JSON line to a file named by
the `LOUSHY_EVAL_RESULTS` environment variable, which `loushy eval` sets and
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
      - run: npx loushy eval --junit reports/evals.xml --json reports/evals.json
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
