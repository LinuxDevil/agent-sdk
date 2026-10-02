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
| `input` | Each new user message (the user messages that end the transcript) | Before the first model call. A block makes no model call. |
| `output` | The final assistant text; in a streamed run, every step's text | Before it is emitted: before its `text.done`, and before `run.done`. |
| `tools` | A tool call's arguments (`text` is them as JSON, `args` the object) | After the [permission rules](./approvals.md#permission-policies) (skipped when a rule denies the call) and before `needsApproval`. |

A guardrail is `{ name, check(ctx) }`. `ctx` has `kind` (`'input'`, `'output'`
or `'tool'`), `text`, the run's `messages`, `toolName` and `args` for a tool
call, and the run's `signal`. `check` returns (or resolves to) `{ ok: true }`
or `{ ok: false, reason, action?, replacement? }`:

- `action: 'block'` (the default) ends the run with `finishReason: 'guardrail'`
  and `result.guardrail` (`{ name, kind, reason, toolName? }`). `result.text`
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
`SandboxAdapter` instead of calling `execute`:

```ts
import { AgentExecutor, SubprocessSandbox } from '@lousho/build-ai-agent';

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
