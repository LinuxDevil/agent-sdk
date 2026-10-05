# coding-harness

A small coding harness assembled from Lousho's building blocks in one `createCodingHarness()` function. It stacks the layers most open-source harnesses share (OpenCode, Codex, Pi, Crush) on one `createAgent()` call:

| Layer | Lousho feature |
|---|---|
| Instructions per model family | `instructionsFor(model)` |
| Workspace tools with undo | `createFsTools(workspace, { checkpoints })` |
| A shell limited to an allow list | `createShellTool(workspace, { allow })` |
| Permission rules, an approver, an audit log | `permissions`, `approve`, `onPermissionDecision` |
| Loop guard and output cap | `hooks` |
| Context compaction | `compaction: { thresholdPercent: 0.8 }` |
| A playbook loaded on demand | `defineSkill()` |
| A read-only explorer sub-agent | `subagents: { explorer }` |
| A spend cap | `limits: { maxCostUsd: 0.05 }` |

The task: `math.js`'s `add()` subtracts, so `node --test` fails. The harness must fix the code, never touch the test, and refuse `rm`.

## Run it

```bash
npx tsx examples/coding-harness/index.ts                         # offline, scripted models
OPENROUTER_API_KEY=... npx tsx examples/coding-harness/index.ts  # live, openrouter/openai/gpt-4o-mini
```

Offline it works on an in-memory project with a faked `node --test`. Live it copies the project into a temporary directory and runs real commands there, capped at 0.05 USD a run.

## Test it

```bash
npx vitest run examples/coding-harness
```

The tests check the fix, the refused `rm`, that test files stay untouched, the loop guard, the checkpoint rewind, and the per-family instructions.
