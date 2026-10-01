# Guardrails and sandboxing

Two tools for running agent output and agent tools safely: **guardrails** are
fail-closed checks over a proposed change before you act on it, and
**sandboxed tools** run inside an isolated container instead of the host
process. For per-call human decisions see [Approvals](./approvals.md); for
hooks that inspect or veto each tool call see `HookRegistry` in the
[API overview](./api-overview.md#flows-evals-observability-and-security).

## Guardrails

`runGuardrails(action, guardrails)` runs every check concurrently over a
proposed patch and rolls the results up into one verdict. The
[ops-pipeline example](../examples/ops-pipeline) uses it to gate a fixer
agent's patch before a pull request is opened:

```ts
import { runGuardrails, secretScanGuardrail, createDiffSizeGuardrail, createCommandGuardrail } from '@loushy/build-ai-agent';

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
import { AgentExecutor, SubprocessSandbox } from '@loushy/build-ai-agent';

// Route a flagged tool (requiresSandbox + sandboxExecute) through a real,
// Docker-backed sandbox instead of the in-process NoopSandbox default
await AgentExecutor.execute({ agent, input, provider, toolRegistry, sandbox: new SubprocessSandbox() });
```

- `NoopSandbox` (the default) runs on the host. It is a stand-in, not
  isolation.
- `SubprocessSandbox` runs each command in a new, network-isolated,
  auto-removed Docker container, with no host directory mounted except the
  `cwd` you pass. It needs a running Docker daemon and the `dockerode` package
  (loaded on first use).
- Implement `SandboxAdapter` (`name`, `run(cmd, args, opts)`, `writeFile(path, content)`)
  for another backend.

For coding agents, `SandboxShell` puts the workspace shell tool behind the same
adapter; see [Workspace tools](./workspace-tools.md#sandboxed-shell-sandboxshell).
