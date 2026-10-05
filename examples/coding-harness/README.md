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

## The same harness as a kit

`registry/coding-kit/` is this harness expressed as an agent directory and
shipped through the registry: `agent.json` carries the model, the permission
rules, `hooks` / `approve` paths, compaction and the cost cap;
`instructions/<family>.md` replaces `instructionsFor()`; the skill and the
explorer are directories on disk.

```bash
lousho add coding-kit --dir ./my-agent --yes --allow exec,fs-write
lousho dev ./my-agent
```

`kit.test.ts` installs it with `lousho add`, loads it with `loadAgentDir()`,
runs the same scripted scenario as `index.test.ts` (provider and explorer
provider injected through loader overrides), and builds it into a node-server
deployment whose `POST /chat` answers the same task. The live test runs
against `openrouter/openai/gpt-4o-mini` when `OPENROUTER_API_KEY` is set.

## The production variant: `coding-pi`

`registry/coding-pi/` is the same kit on the full Pi stack: the lead's `model`
is `pi/openrouter/openai/gpt-4o-mini` (the `pi` provider over
`@earendil-works/pi-ai`) and `subagents/coder/` declares `"engine": "pi"` - a
`piAgent()` coding sub-agent the lead reaches through the `task` tool, with
its own permission rules gating the Pi session's calls (no `rm`, no edits to
`*.test.*`). It is the closest thing to a production coding agent here:
durable approval pause/resume across restarts, per-sub-agent permissions, and
usage that rolls into the lead run.

```bash
lousho add coding-pi --dir ./my-agent --yes --allow exec,fs-write,network,env
OPENROUTER_API_KEY=... lousho dev ./my-agent
```

`kit-pi.test.ts` installs it, runs it offline (a mock lead delegates through
`task` to a Pi session on pi-ai's faux provider - the session edits the
installed workspace for real), and runs the whole stack live on OpenRouter
when `OPENROUTER_API_KEY` is set. Node-only: it needs the optional peers
`@earendil-works/pi-ai@1.0.3` and `@earendil-works/pi-coding-agent@1.0.2`, and
the `node-server` or `docker` build target.
