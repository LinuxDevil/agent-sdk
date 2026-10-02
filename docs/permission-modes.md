# Permission modes

A permission mode puts an agent in a named state instead of writing rules: look
but do not touch (`plan`), edit files without asking (`acceptEdits`), or never
pause (`dontAsk`). Switch it in the middle of a session, the way you would work
with a coding agent: plan first, then let it edit.

```ts
import { createAgent, createFsTools, MemoryWorkspace } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const workspace = new MemoryWorkspace({ files: { 'notes.md': '# Notes\n' } });
const agent = createAgent({
  provider: mockModel(['I would add a "Todo" section to notes.md.', 'Done.']),
  instructions: 'You are a coding agent.',
  tools: createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
});

const session = agent.session({ permissionMode: 'plan' });
await session.send('Plan how to add a todo list to notes.md.'); // reads only; writes are refused
session.setPermissionMode('acceptEdits');
await session.send('Apply the plan.'); // write_file and edit_file run without asking
```

The modes are presets over the [permission rules](./approvals.md#permission-policies)
and `needsApproval`, not a second system: they apply last, to what the rules,
guardrails and the tool's own `needsApproval` decided.

## The modes

| Mode | Read-only tools | File edits | Other tools that ask | Other tools that do not ask |
| --- | --- | --- | --- | --- |
| `'default'` | Normal gate | Normal gate | Pause for approval | Run |
| `'plan'` | Normal gate (they may still ask) | Denied | Denied | Denied |
| `'acceptEdits'` | Normal gate | Run without asking | Pause for approval | Run |
| `'dontAsk'` | Normal gate, but a call that would ask is denied | Denied when they would ask | Denied | Run |

- **`plan`**: a call to a tool that is not read-only is refused with
  `kind: 'denied'` and the reason `The agent is in plan mode: it may read but
  not change anything. Describe the change instead.` - also when an `allow`
  rule matched it. A run that starts in plan mode also gets one paragraph in its
  system prompt telling the model so. A call to an unknown tool still gets the
  normal not-found error, so the model sees the real problem.
- **`acceptEdits`**: a call that would pause for approval runs without asking
  when its tool is a file edit (`editsFiles`, below). Everything else is
  unchanged.
- **`dontAsk`**: a call that would pause for approval - an `ask` rule,
  `needsApproval`, or `ask_question` - is refused with the reason `The agent is
  in dontAsk mode: calls that need approval are refused.` Calls an `allow` rule
  approved and calls that need no approval run. Nothing pauses, so an `approve`
  callback is never called.

### Which tools are read-only

Plan mode lets a tool run only when it says it changes nothing. A tool that
says nothing is treated as one with side effects and is refused.

- A tool with `annotations: { readOnlyHint: true }`. Built in: `read_file`,
  `list_dir`, `glob`, `grep`, `todo_read`, `current_date`, `day_name`,
  `web_fetch`, `load_skill`, every `recall_<name>` memory tool, and
  `agent_status` / `agent_await` (they watch background sub-agents). An
  [OpenAPI tool](./openapi-tools.md) for a `GET` operation has it too, and an
  [MCP tool](./mcp.md) keeps the hint its server sent: it is the server's word,
  not a guarantee, so only connect servers you trust.
- The built-in `ask_question` (it only asks; the call still pauses for the
  answer) and `task` (its sub-agent inherits plan mode, see below).

Declare a custom read-only tool like this:

```ts
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const lookUpOrder = defineTool({
  name: 'look_up_order',
  description: 'Read an order by id',
  input: z.object({ id: z.string() }),
  annotations: { readOnlyHint: true },
  execute: async ({ id }) => ({ id, status: 'shipped' }),
});
```

The hint is a promise you make about your tool: plan mode trusts it.

### File edits: the `editsFiles` marker

`acceptEdits` approves only tools marked as file edits: `write_file` and
`edit_file` from `createFsTools()`, and any tool defined with `editsFiles: true`
(stored as `metadata.editsFiles`). A tool is never a file edit by its name
alone, so a tool of your own named `write_file` is not approved silently.

```ts
import { defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const appendLine = defineTool({
  name: 'append_line',
  description: 'Append a line to a file in the project',
  input: z.object({ path: z.string(), line: z.string() }),
  needsApproval: true,
  editsFiles: true,
  execute: async ({ path, line }) => `appended to ${path}: ${line}`,
});
```

## Order of evaluation

For each tool call, in this order:

1. Argument validation, then `preToolCall` [hooks](./hooks.md). A hook deny ends here.
2. Permission rules (`permissions`). A `deny` rule ends here.
3. Tool [guardrails](./guardrails.md). A block ends the run.
4. The tool's own `needsApproval`. A deny ends here; an `allow` or `ask` rule replaces its ask.
5. The permission mode, on what is left.

So no mode turns a deny into a run: a hook deny, a `deny` rule and a
`needsApproval` deny still deny in every mode, and `acceptEdits` never approves
a call a guardrail blocked.

## Setting and switching the mode

- `createAgent({ permissionMode })`: the agent's mode. A function is read at
  every tool call, so a mode you switch while a run is going applies to its
  next call.
- `agent.send(message, { permissionMode })` / `agent.stream(...)`: the mode for
  that run only.
- `agent.session({ permissionMode })`, then `session.setPermissionMode(mode)`
  and the `session.permissionMode` getter. The session reads its mode at every
  tool call of a turn, so `setPermissionMode()` during a turn (from a
  `tool.start` listener, say) applies from the next tool call of that turn. A
  session defaults to the agent's mode.

Switching is always an explicit call to `setPermissionMode()`. Each switch is
reported to `onPermissionModeChange` with `{ sessionId, from, to, at }`:

```ts
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({
  provider,
  instructions: 'You are a coding agent.',
  onPermissionDecision: (entry) => console.log(entry.toolName, entry.decision, entry.mode),
  onPermissionModeChange: ({ sessionId, from, to, at }) => console.log(at, sessionId, `${from} -> ${to}`),
});
```

The system prompt is set when a run starts: only a run (or session turn) that
starts in plan mode is told about it. A switch during a run is enforced by the
tool-call gate alone, which is enough because the denied call's reason tells
the model.

## The audit log

While a mode other than `'default'` is set, every tool call's decision is
audited, even when the agent sets neither `permissions` nor
`onPermissionDecision`: it goes to `onPermissionDecision` (when set) and is
streamed as a `permission.decision` event. The entry's `mode` field is set when
the mode changed the call's outcome: `'plan'` or `'dontAsk'` with
`decision: 'deny'` and the mode's `reason`, `'acceptEdits'` with
`decision: 'allow'`. When the mode denied a call an `allow` rule matched, the
entry keeps that rule's `rule.index`. Mode switches go to
`onPermissionModeChange`.

## Sub-agents

A sub-agent (the `task` tool, a background task, `createDelegateTool()`) runs
under the lead's mode while the lead's mode is not `'default'`, and under its
own `permissionMode` otherwise. A sub-agent created with
`permissionMode: 'plan'` stays in plan mode whatever the lead's mode is. The mode is read at each of the sub-agent's tool
calls, so switching the lead's session mode applies to a sub-agent that is
running. That is what makes `task` safe in plan mode: the sub-agent cannot
change anything either.

A [remote sub-agent](./sub-agents.md) (`remoteAgent()`) runs on another server
under that server's own permissions, so it cannot be held to the lead's mode: in
plan mode a `task` call to it is refused without contacting it, and in
`dontAsk` mode a remote approval fails the task instead of pausing the lead.

## Resuming after an approval

The mode is not saved in checkpoints or approval snapshots. A run continued by
`agent.approvals.resolve()` uses the paused session's current mode when the
paused run belonged to a session, else the agent's mode (not the mode a
`send()` call passed). So a turn paused in `'default'` and resolved after
`session.setPermissionMode('dontAsk')` runs the approved call and then refuses
the calls after it that would ask. In plan mode the approved call itself is
refused too when its tool is not read-only.

A resume in another process uses the mode the resuming agent or session has.
