# Build a coding agent

This page builds a terminal coding agent in the style of Claude Code: it reads
and edits files in your project, runs commands, asks you before it writes a
file or runs something risky, and keeps the conversation going for follow-up
questions. You need Node 22, an API key in the environment variable your model
provider expects (`OPENAI_API_KEY` for the model used here) and a project
directory to run it in. The finished file is at the end of
[step 5](#5-keep-the-conversation), and you run it as
`npx tsx coding.ts "Fix the failing test"`.

## 1. Give the agent a workspace

A workspace is a directory the agent may work in. `NodeWorkspace` is both a
file system and a shell for it, and `createFsTools()` and `createShellTool()`
turn it into tools.

```ts
import { NodeWorkspace, createFsTools, createShellTool } from '@lousho/build-ai-agent';

const workspace = new NodeWorkspace({ root: process.cwd() });
const tools = [...createFsTools(workspace), createShellTool(workspace)];
```

The `root` matters: every path the model passes is confined to it, and `..`,
absolute paths and drive letters are rejected (see the
[security model](./workspace-tools.md#security-model)). Run the program from
the project directory and use `process.cwd()` as the root, so the file tools
cannot reach anything outside the project.

The model sees seven tools: `read_file`, `write_file`, `edit_file`,
`list_dir`, `glob` and `grep` from `createFsTools()`, and `shell` from
`createShellTool()`. Their arguments and options are in
[Workspace tools](./workspace-tools.md#the-tools).

## 2. Decide what needs approval

A tool with `needsApproval` pauses the run before it executes, so a human
decides. Reading is harmless, so gate the file tools that change things with a
per-tool map. For the shell, pass a predicate over the command string and gate
only the commands you consider risky.

```ts
import { NodeWorkspace, createFsTools, createShellTool } from '@lousho/build-ai-agent';

const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;

const workspace = new NodeWorkspace({ root: process.cwd() });
const tools = [
  ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
  createShellTool(workspace, { needsApproval: (command) => DESTRUCTIVE.test(command) }),
];
```

The shell tool asks for approval by default (`needsApproval: true`); the
predicate above lets everything else, such as `npm test` or `git status`, run
without asking. The other way to skip the question is an `allow` list of the
commands you trust, with `needsApproval: false`, as shown at the top of
[Workspace tools](./workspace-tools.md). A string entry there allows the
command and ordinary flags only — arguments that point outside the workspace
(a `..` segment, `~` or an absolute path) still need an anchored RegExp. The regular expression is a
convenience, not a security boundary: a shell command can be written in many
ways. For anything you do not control, keep the default and approve every
command, or run the shell in a sandbox (see `SandboxShell` in
[Workspace tools](./workspace-tools.md#sandboxed-shell-sandboxshell)).

## 3. Run it and stream the answer

Create the agent with the tools, then call `agent.stream()`. It returns a run
you iterate for typed events: `text.delta` carries the model's text as it is
written and `tool.start` announces each tool call (see
[Streaming](./streaming.md)).

```ts
import { NodeWorkspace, createAgent, createFsTools, createShellTool } from '@lousho/build-ai-agent';

const workspace = new NodeWorkspace({ root: process.cwd() });
const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a careful coding agent. Read before you edit; run the tests after every change.',
  maxSteps: 30,
  tools: [
    ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
    createShellTool(workspace),
  ],
});

const run = agent.stream('Fix the failing test');
for await (const event of run) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
  if (event.type === 'tool.start') console.log(`\n> ${event.toolName} ${JSON.stringify(event.args)}`);
}
```

`maxSteps` bounds the model calls in one run, so a confused agent cannot loop
forever. This program stops at the first gated call: the stream ends with an
`approval.requested` event and the run finishes as `'awaiting-approval'`. The
next step handles that. The `vendor/` model prefix chooses the provider; with
OpenRouter use `openrouter/<vendor>/<model>` (e.g.
`openrouter/openai/gpt-4o-mini`).

## 4. Handle the pause

When the stream ends, `await run.result` gives the final result. If the run
paused, `result.approvalId` names the pending call. Ask the user, then
continue with `agent.approvals.streamResolve()`, which returns a new run for
the rest of the work. That run can pause again, so loop until there is no
`approvalId`.

```ts
import { createInterface } from 'node:readline/promises';
import { createAgent, type AgentRun } from '@lousho/build-ai-agent';

const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a coding agent.' });
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function drain(first: AgentRun): Promise<void> {
  let run = first;
  for (;;) {
    for await (const event of run) {
      if (event.type === 'text.delta') process.stdout.write(event.text);
      if (event.type === 'tool.start') console.log(`\n> ${event.toolName} ${JSON.stringify(event.args)}`);
    }
    const { approvalId } = await run.result;
    if (!approvalId) return;
    const answer = await rl.question('\nApprove this call? [y/N] ');
    run = agent.approvals.streamResolve({ id: approvalId, approved: answer.trim().toLowerCase() === 'y' });
  }
}

try {
  await drain(agent.stream('Fix the failing test'));
} finally {
  rl.close();
}
```

Two details of the continued stream. The call you just approved resumes with
a `tool.resume` event - its `tool.start` was already printed by the run that
paused, so the loop prints each call once (`tool.resume` is the event to
match if you want to mark the call running again). And a
rejected call does not fail the run: the model gets a rejection result instead
of the tool output and carries on. To tell it why, pass a `note`:
`streamResolve({ id, approved: false, note: 'Do not touch the lockfile' })`.
The `try` / `finally` closes the `readline` interface even when `run.result`
rejects because the run failed.

The `approval.requested` event also carries `toolName` and `args`, so you can
print what the call will do before you ask. See [Approvals](./approvals.md)
for the whole API.

## 5. Keep the conversation

So far each task starts from nothing. An `agent.session()` keeps the
transcript, so a follow-up such as "now add a test for the empty case" sees the
earlier turns. `session.stream(input)` is `agent.stream()` for a conversation
and returns the same kind of run; a turn that pauses on a gated call continues
in the same session when you resolve it through the same agent (see
[Streaming a session turn](./sessions.md#streaming-a-session-turn)). Turn the
loop into a REPL: one `session.stream()` per line the user types, with the
same pause handling.

```ts
// coding.ts
// Run: OPENAI_API_KEY=... npx tsx coding.ts "Fix the failing test"
import { createInterface } from 'node:readline/promises';
import { NodeWorkspace, createAgent, createFsTools, createShellTool, type AgentRun } from '@lousho/build-ai-agent';

const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;

const workspace = new NodeWorkspace({ root: process.cwd() });
const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a careful coding agent. Read before you edit; run the tests after every change.',
  maxSteps: 30,
  tools: [
    ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
    createShellTool(workspace, { needsApproval: (command) => DESTRUCTIVE.test(command) }),
  ],
});
const session = agent.session();
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function drain(first: AgentRun): Promise<void> {
  let run = first;
  for (;;) {
    for await (const event of run) {
      if (event.type === 'text.delta') process.stdout.write(event.text);
      if (event.type === 'tool.start') console.log(`\n> ${event.toolName} ${JSON.stringify(event.args)}`);
    }
    const { approvalId } = await run.result;
    if (!approvalId) return;
    const answer = await rl.question('\nApprove this call? [y/N] ');
    run = agent.approvals.streamResolve({ id: approvalId, approved: answer.trim().toLowerCase() === 'y' });
  }
}

try {
  let line = process.argv[2] ?? (await rl.question('> '));
  while (line.trim() && line.trim() !== 'exit') {
    await drain(session.stream(line));
    process.stdout.write('\n');
    line = await rl.question('> ');
  }
} finally {
  rl.close();
}
```

The first task comes from the command line (or a prompt if there is none);
after each answer the program asks for the next line, and an empty line or
`exit` ends it. The session lives in memory, so it ends with the process; to
keep a conversation across runs, give the agent a store (see
[Choosing a store](./sessions.md#choosing-a-store)).

## 6. Test it without a model

The agent needs no network to test. A `MemoryWorkspace` keeps the files in
memory and takes a scripted `exec` for the shell, and `mockModel` plays the
model. Assert on `workspace.snapshot()` and `workspace.commands`.

```ts
import { createAgent, createFsTools, createShellTool, MemoryWorkspace } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const workspace = new MemoryWorkspace({
  files: { 'math.js': 'exports.add = (a, b) => a - b;\n' },
  exec: (command) => (command === 'node --test' ? { stdout: 'pass 1\n' } : { exitCode: 1, stderr: 'unknown command\n' }),
});
const agent = createAgent({
  instructions: 'Fix bugs. Run the tests after every change.',
  provider: mockModel([
    { toolCalls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
    'Fixed add(); the tests pass.',
  ]),
  tools: [...createFsTools(workspace), createShellTool(workspace, { needsApproval: false })],
});

await agent.send('add() is broken');
console.log(workspace.snapshot()['math.js']); // 'exports.add = (a, b) => a + b;\n'
console.log(workspace.commands.map((c) => c.command)); // ['node --test']
```

To test the approval path, gate `write_file` the way the real agent does.
`send()` resolves with `finishReason: 'awaiting-approval'` and an
`approvalId`, the file is still unchanged, and `agent.approvals.resolve()`
runs the write and finishes the turn.

```ts
import { createAgent, createFsTools, MemoryWorkspace } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const workspace = new MemoryWorkspace({ files: { 'notes.txt': 'old\n' } });
const agent = createAgent({
  instructions: 'Write notes.',
  provider: mockModel([
    { toolCalls: [{ name: 'write_file', args: { path: 'notes.txt', content: 'new\n' } }] },
    'Wrote the file.',
  ]),
  tools: createFsTools(workspace, { needsApproval: { write_file: true } }),
});

const paused = await agent.send('Update the notes');
console.log(paused.finishReason, workspace.snapshot()['notes.txt']); // 'awaiting-approval' 'old\n'

const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
console.log(done.text, workspace.snapshot()['notes.txt']); // 'Wrote the file.' 'new\n'
```

To check the real prompt and tool schemas against a model once and replay the
recording afterwards, see [Record and replay](./testing.md#record-and-replay).

## Next steps

- [Workspace tools](./workspace-tools.md): the full tool reference, the security model, and `SandboxShell` to run commands in Docker.
- [Undo the agent's file changes](./workspace-tools.md#the-tools): pass `createFsTools(workspace, { checkpoints })` a `WorkspaceCheckpoints`, then `checkpoints.rewind(turn, { sessionId: session.id, dryRun: true })` shows what rewinding to a turn would restore.
- [Approvals](./approvals.md): durable approval stores, `approve` callbacks and deciding from another process.
- [Streaming](./streaming.md): every event type, cancelling a run, and the web stream formats.
- [Sessions](./sessions.md): stores, limits and durable sessions.
- [Durable execution](./durable-execution.md): surviving a crash in the middle of a long run.
- [Configuration](./configuration.md): `projectInstructions: true` appends your `AGENTS.md` or `CLAUDE.md` to the instructions.
