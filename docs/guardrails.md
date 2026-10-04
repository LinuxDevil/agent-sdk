# Guardrails and sandboxing

Tools for running agents safely: **input and output guardrails** check what
goes into and comes out of any run (and its tool arguments), **patch
guardrails** are fail-closed checks over a proposed change before you act on
it, and **sandboxed tools** run inside an isolated container instead of the
host process. For per-call human decisions see [Approvals](./approvals.md); for
hooks that inspect or veto each tool call see [Hooks](./hooks.md).

## Input and output guardrails

`createAgent({ guardrails })` (or `ExecuteOptions.guardrails`) checks a run at
three points, each list in order:

| List | Runs on | When |
| ---- | ------- | ---- |
| `input` | Each new user message (the user messages that end the transcript) | Before the first model call. A block makes no model call. A `runInParallel` input guardrail runs while the first model call is in flight instead (see below). |
| `output` | The final assistant text; in a `stream()` run (one you iterate), every step's text. `send()` with a listener checks the final text only. | Before it is emitted: before its `text.done`, and before `run.done`. |
| `tools` | A tool call's arguments (`text` is them as JSON, `args` the object) | After the [permission rules](./approvals.md#permission-policies) (skipped when a rule denies the call) and before `needsApproval`. |

**Parallel input guardrails.** A slow input check (one that calls a model,
such as `moderationGuardrail({ model })`) adds its whole latency before the
agent starts answering. Mark it `runInParallel: true` (on your own
`IoGuardrail`, or as an option of `promptInjectionGuardrail` and
`moderationGuardrail`) and it runs while the first model call is already in
flight: the blocking input guardrails (the default) run first, including their
rewrites, then the parallel ones start together on that input and the model
call starts at once. Until every parallel check has passed, nothing the call
produced is released: its `text.delta`, `reasoning.*` and provider-run tool
events are held (`step.start` is not), in order, and its tool calls do not
run; a reply that comes first waits for the checks. When they pass, the held
events go out and the run goes on exactly as with blocking guardrails. When one
trips, the model call is aborted, the held events are dropped, nothing of the
call reaches the transcript, a checkpoint or `onLLMResponse`, and the run ends
with `finishReason: 'guardrail'` and `guardrail.tripped` (or
`GuardrailError` with `onTripped: 'throw'`) like a blocking trip. A parallel
check cannot rewrite, because the model already has the input: a `rewrite`
result blocks, with the reason starting `runInParallel guardrails cannot
rewrite: `. The trade-off is cost: a tripped call may already have used tokens.
They count in `result.usage` when the provider reported them (a call that
finished before the trip); an aborted stream usually reports none, and none is
estimated. Only the first model call of a run is raced, and a run resumed after an
approval does not check its input again. On `output` and
`tools` guardrails `runInParallel` is ignored. A guardrail `model` string is a
`provider/model` spec: the `vendor/` prefix chooses the provider; with
OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

```ts
import { createAgent, moderationGuardrail, piiGuardrail } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider,
  guardrails: {
    // The PII check is instant and may rewrite, so it blocks; the moderation call runs alongside the agent's.
    input: [piiGuardrail({ action: 'rewrite' }), moderationGuardrail({ model: 'openai/gpt-4o-mini', runInParallel: true })],
  },
});
```

A guardrail is `{ name, check(ctx) }`. `ctx` has `kind` (`'input'`, `'output'`
or `'tool'`), `text`, the run's `messages`, `toolName` and `args` for a tool
call, and the run's `signal`. `check` returns (or resolves to) `{ ok: true }`
or `{ ok: false, reason, action?, replacement?, info? }`:

- `action: 'block'` (the default) ends the run with `finishReason: 'guardrail'`
  and `result.guardrail` (`{ name, kind, reason, toolName?, info? }`). `result.text`
  is `''` and a blocked reply is not added to the transcript; a blocked tool
  call does not run (nor do the calls after it in that turn) and gets a
  "cancelled" result, so the transcript stays valid. `stream()` emits
  `guardrail.tripped` before `run.done`.
- `action: 'rewrite'` replaces the text with `replacement` (a tool call's
  arguments: `replacement` is the new arguments as JSON), the next guardrail
  sees the new text, and `stream()` emits `guardrail.rewrote`.

With `onTripped: 'throw'` a block rejects with `GuardrailError`
(`LOUSHO_GUARDRAIL_TRIPPED`, with the same `guardrail`) instead. A `check`
that throws fails the run. Sub-agents run their parent's guardrails, then their
own. Agent spec files name built-in guardrails in `policy.guardrails` (see [Configuration](./configuration.md#policy-policy)).

```ts
import {
  createAgent,
  denyTopicsGuardrail,
  GuardrailError,
  llmJudgeGuardrail,
  maxLengthGuardrail,
  regexGuardrail,
  type IoGuardrail,
} from '@lousho/build-ai-agent';

const noProdWrites: IoGuardrail = {
  name: 'no-prod-writes',
  check: ({ toolName, args }) =>
    toolName === 'run_sql' && String(args?.db) === 'prod' ? { ok: false, reason: 'prod is read-only' } : { ok: true },
};

const agent = createAgent({
  provider,
  guardrails: {
    input: [maxLengthGuardrail({ maxChars: 4_000 }), denyTopicsGuardrail({ topics: ['medical advice'] })],
    output: [
      regexGuardrail({ name: 'secrets', action: 'rewrite' }),
      llmJudgeGuardrail({ model: 'openai/gpt-4o-mini', instruction: 'Replies must stay on the topic of cooking.' }),
    ],
    tools: [noProdWrites],
  },
});

const result = await agent.send('What should I cook tonight?');
if (result.finishReason === 'guardrail') {
  console.warn(`Blocked by ${result.guardrail?.name} (${result.guardrail?.kind}): ${result.guardrail?.reason}`);
}

try {
  await createAgent({ provider, guardrails: { input: [maxLengthGuardrail({ maxChars: 10 })], onTripped: 'throw' } }).send('A long question');
} catch (error) {
  if (error instanceof GuardrailError) console.error(error.guardrail);
}
```

| Built-in | Fails when |
| -------- | ---------- |
| `maxLengthGuardrail({ maxChars })` | The text is longer than `maxChars` characters. |
| `regexGuardrail({ name, pattern?, action?, replacement? })` | The text matches `pattern` (a `RegExp` or a list; default: the `secretScanGuardrail` patterns). With `action: 'rewrite'` every match becomes `replacement` (default `'[redacted]'`). |
| `denyTopicsGuardrail({ topics })` | The text contains one of `topics` (case-insensitive keywords). |
| `llmJudgeGuardrail({ model, instruction, name? })` | `model` (an `LLMProvider` or `"provider/model"`), asked once per check whether the text follows `instruction`, does not reply `PASS`; its `FAIL: <reason>` is the reason. |
| `piiGuardrail({ types?, action?, name? })` | The text contains personal data of one of `types` (default all): `email`, `phone` (9 to 15 digits, optional `+` country code and separators), `credit-card` (must pass the Luhn check), `iban` (must pass its mod-97 check), `us-ssn` (`123-45-6789` form), `ip-address` (IPv4). Blocks by default; `action: 'rewrite'` replaces each match with `[<type>]`, e.g. `[email]`. Heuristic, no model call. |
| `secretsGuardrail({ action?, extraPatterns?, name? })` | The text contains a private key, an Anthropic (`sk-ant-`), OpenRouter (`sk-or-v1-`), OpenAI (`sk-proj-`, `sk-`), AWS (`AKIA`), GitHub (`ghp_` and the other `gh?_` prefixes, `github_pat_`), Slack (`xoxb-` and the like), Google (`AIza`) or Stripe live (`sk_live_`, `rk_live_`) key, a JWT, an `Authorization: Bearer` token, or a match of `extraPatterns`. Rewrites each match to `[secret]` by default; `action: 'block'` blocks. Heuristic, no model call. |
| `promptInjectionGuardrail({ model?, name?, runInParallel? })` | The text has a prompt-injection signal: "ignore (all) previous instructions" and similar, "you are now", a request for the system prompt, a chat-template role marker (`<\|im_start\|>`, `### System:`, `[INST]`), a known jailbreak phrase, or invisible Unicode tag characters (U+E0000 to U+E007F). With `model`, a text the patterns pass is also sent to the model, which must reply `SAFE` or `INJECTION: <reason>`. Blocks only. |
| `moderationGuardrail({ model, categories?, name?, runInParallel? })` | `model`, asked once per check with a fixed prompt, lists one of `categories` (default all: `hate`, `harassment`, `self-harm`, `sexual`, `sexual-minors`, `violence`, `illicit`) as applying; it replies `NONE` or the categories. A prompt rather than a vendor moderation endpoint, so it works with every provider. Blocks only. With `runInParallel: true` (also on `promptInjectionGuardrail`), an input check runs alongside the first model call. |

The last four are a starter set for checks most production agents need:

```ts
import { createAgent, piiGuardrail, promptInjectionGuardrail, secretsGuardrail } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider,
  guardrails: {
    input: [promptInjectionGuardrail(), piiGuardrail({ action: 'rewrite' })],
    output: [secretsGuardrail()],
  },
});

const result = await agent.send('My card is 4111 1111 1111 1111, can you check my order?');
// The model sees "My card is [credit-card], can you check my order?"
if (result.guardrail?.info?.category === 'prompt-injection') console.warn(result.guardrail.info.signals);
```

**What tripped, without the text.** A trip (`result.guardrail`, `guardrail.tripped`,
`guardrail.rewrote`, `GuardrailError.guardrail`) carries `info`, a
`GuardrailTripInfo` when the guardrail gives one, which the starter set always
does: `{ category: 'pii', matches: [{ type, start, end }] }`,
`{ category: 'secret', matches: [{ label, start, end }] }`,
`{ category: 'prompt-injection', source: 'heuristic' | 'model', signals }` or
`{ category: 'moderation', categories }`. Offsets point into the checked text
(`ctx.text`). `info` never contains the matched text, and neither does the
`reason` of the PII and secret checks (types and labels only), so events,
traces and logs do not copy the personal data or the secret. Your own
guardrail can return `info: { category: 'custom', ...anything }`.

**Limits.** The PII, secret and prompt-injection checks are heuristic pattern
checks: they catch the common forms listed above and miss others (personal data
in other formats or languages, a secret with an unknown prefix, an injection
that is paraphrased, translated or encoded), and they flag some harmless text
too (an order number that looks like a phone number, a version string that
looks like an IP address, a user asking about "system prompts"). Treat them as
a first filter, not a security boundary; keep tool permissions and approvals in
place for anything that matters. The model-backed checks are only as reliable
as the model, cost one call per checked text, and fail closed: a reply that is
neither form blocks, with a reason saying the reply could not be read. Tool
results (for example a fetched web page carrying an indirect injection) are not
checked by any guardrail yet.

## Patch guardrails

`runGuardrails(action, guardrails)` runs every check concurrently over a
proposed patch and rolls the results up into one verdict. The
[ops-pipeline example](../examples/ops-pipeline) uses it to gate a fixer
agent's patch before a pull request is opened:

```ts
import { runGuardrails, secretScanGuardrail, createDiffSizeGuardrail, createCommandGuardrail } from '@lousho/build-ai-agent';

const verdict = await runGuardrails(
  { diff: patch },
  [
    secretScanGuardrail,
    createDiffSizeGuardrail(500),
    createCommandGuardrail('test-run', repoPath, 'npm', ['test']),
  ],
);

if (!verdict.pass) {
  console.log(verdict.failures); // [{ name, reason }, ...] — never call the write-side tool
}
```

| Guardrail | Fails when |
| --------- | ---------- |
| `secretScanGuardrail` | The diff contains a private key header, an OpenAI-style API key or an AWS access key. |
| `createDiffSizeGuardrail(maxLines)` | The diff has more than `maxLines` lines. |
| `createCommandGuardrail(name, cwd, command, args, { timeoutMs? })` | The command exits non-zero. A non-empty diff is first applied (`git apply`) to a scratch copy of `cwd`, and fails the check if it does not apply cleanly. |
| `createTestRunGuardrail(repoPath)`, `createLintGuardrail(repoPath)` | `npm test` / `npm run lint` fails (shorthands for the command guardrail). |

**Fail-closed.** A guardrail that throws, rejects, does not settle within its
timeout (30 s by default), or resolves with anything but `pass: true` counts as
failed: `runGuardrailSafely(guardrail, action)` wraps each one. A command
guardrail kills its process when the timeout fires (on Windows, the whole
process tree). Write your own as `{ name, check(action) }` returning
`{ pass, reason? }`.

## Sandboxed tools

A tool opts in with `requiresSandbox: true` and a `sandboxExecute(args, sandbox)`
function. The executor then calls `sandboxExecute` with the run's
`SandboxAdapter` instead of calling `execute`. `createAgent()` does not take
`sandbox` yet, so this goes through the executor.

#### Advanced: the executor API

```ts
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { SubprocessSandbox } from '@lousho/build-ai-agent';

// Route a flagged tool (requiresSandbox + sandboxExecute) through a real,
// Docker-backed sandbox instead of the in-process NoopSandbox default
await AgentExecutor.execute({ agent, input, provider, toolRegistry, sandbox: new SubprocessSandbox() });
```

- `NoopSandbox` (the default) runs on the host. It is a stand-in, not
  isolation.
- `SubprocessSandbox` runs each command in a new, network-isolated,
  auto-removed Docker container, with no host directory mounted except the
  `cwd` you pass. It needs a running Docker daemon and the optional peer
  `dockerode` (`npm install dockerode@^5.0.1`; loaded on first use). When the
  run is cancelled (`run.abort()`, `signal`) or the command times out, the
  container is killed and removed.
- Implement `SandboxAdapter` (`name`, `run(cmd, args, opts)`, `writeFile(path, content)`)
  for another backend.

For coding agents, `SandboxShell` puts the workspace shell tool behind the same
adapter; see [Workspace tools](./workspace-tools.md#sandboxed-shell-sandboxshell).
