# Registry

`lousho add` installs a tool, skill, channel, schedule, memory slot or kit into an
[agent directory](./agent-directories.md) from a registry. A `kit` item is a
whole agent directory: installing it lays out `agent.*`, `instructions.md`,
tools, skills and sub-agents so the target becomes (or grows into) an agent
directory itself. A registry is plain
static JSON: an index plus one document per item that carries the file contents.
The files are copied into your project as source you own and can edit. There is
no runtime plugin loader, and nothing from a registry is executed or imported
while adding it.

`lousho add` works out of the box: without `--registry` or `LOUSHO_REGISTRY` it
reads the default registry at `https://registry.lousho.com/index.json`, which
is the `registry/dist/` folder of the SDK's repository served as static JSON.
When that host cannot be reached, `lousho add` reads the same committed folder
from the repository's `main` branch instead
(`https://raw.githubusercontent.com/LinuxDevil/agent-sdk/main/registry/dist/index.json`);
only the default falls back, never a registry you named.
`--registry` and `LOUSHO_REGISTRY` point it at another registry, and the value
`none` (in either place) disables the registry entirely — `lousho add` then
fails with `LOUSHO_CONFIG_INVALID`, for offline or locked-down use.

The default registry currently carries nine items:

| Name | Type | Permissions it asks for |
| ---- | ---- | ----------------------- |
| `changelog` | skill | none |
| `code-review` | skill | none |
| `coding-kit` | kit (a coding harness as a whole agent directory) | `exec`, `fs-write` |
| `coding-pi` | kit (the coding harness on the Pi provider with a Pi coding sub-agent) | `exec`, `fs-write`, `api.openrouter.ai`, `OPENROUTER_API_KEY` |
| `generic-webhook` | channel | `WEBHOOK_SECRET` |
| `github-issues` | tool (list and create issues; create asks for approval) | `api.github.com`, `GITHUB_TOKEN` |
| `inbox-triage` | kit (a message-triage agent directory: inbox/outbox tools, an approval-gated reply pipeline, a webhook channel, a poll schedule, per-sender memory) | `fs-write`, `INBOX_TRIAGE_HOME`, `INBOUND_TOKEN`, `INBOX_TRIAGE_AUTO_APPROVE`, `OPENROUTER_API_KEY` |
| `incident-response` | kit (an SRE incident-response agent directory: HMAC-verified alert webhook, risk-tiered remediation approvals, an audit timeline) | `fs-write`, `INCIDENT_WEBHOOK_SECRET`, `INCIDENT_TIMELINE_FILE` |
| `open-meteo-weather` | tool | `api.open-meteo.com`, `geocoding-api.open-meteo.com` |

The coding kits (`coding-kit`, `coding-pi`) use the agent directory itself as
the project workspace. Their file tools therefore refuse to change the
agent's own files: `agent.*`, `approve.*`, `hooks.*`, `instructions*`,
`lousho-registry.json`, and anything under `.lousho/`, `tools/`, `skills/`,
`subagents/`, `.git/` and `node_modules/`. Their shell runs only `node --test`
(test file paths, no flags) and `git status`. The kits still run the tests the
agent writes code for, so the agent's code runs as your user. Use a sandboxed
shell for untrusted work (see [Workspace tools](./workspace-tools.md)). The
`coding-pi` kit's Pi coder sub-agent has its own tools, and these rules do not
cover them.

```bash
lousho add --list                       # the default registry's items
lousho add open-meteo-weather --dir ./my-agent
lousho add web-search --registry https://example.com/registry/index.json --dir ./my-agent
LOUSHO_REGISTRY=./registry/index.json lousho add web-search --dry-run
lousho add --list --registry none       # fails: the registry is disabled
```

| Flag | Meaning |
| ---- | ------- |
| `--registry <url-or-path>` | The index: an `http(s)` URL or a local path (`LOUSHO_REGISTRY` when absent, else the default registry). `none` disables the registry. |
| `--dir <agent-dir>` | The agent directory to write into (default: the current directory). It must exist, except for a `kit`, which creates it. For any other item, a directory without `agent.*` or `instructions.md` gets a warning: only an agent directory loads `tools/` and `skills/` (a `lousho init` project imports tools in `src/agent.ts` instead). |
| `--yes`, `-y` | Do not ask for confirmation. Required when stdin is not a terminal. Does not grant elevated permissions on its own (see `--allow`). Both flags are checked before anything is printed: a non-interactive run without them fails with one line naming the exact flags the item needs, e.g. `pass --yes --allow exec,fs-write`. |
| `--allow <list>` | With `--yes`, the elevated permissions you grant, comma-separated: `exec`, `fs-write`, `network`, `env`. An item that asks for one you did not name is refused. |
| `--overwrite` | Replace files that already exist (without it an existing file is `LOUSHO_REGISTRY_FILE_EXISTS`). |
| `--dry-run` | Print the manifest and the files, write nothing, exit 0. |
| `--list` | Print the registry's items and exit. |

Before it writes anything, `lousho add` prints the permission manifest and the
files it will write, checks the item's code against the manifest, then asks
`[y/N]`. After writing, it records the item in `lousho-registry.json`.

## Format

The index is `{ items: [{ name, type, description, url | path }] }`. `type` is
`tool`, `skill`, `channel`, `schedule`, `memory` or `kit`. `url` / `path` locate the
item document; a relative one is resolved against the index's own location.

Each item document is:

```json
{
  "name": "web-search",
  "type": "tool",
  "description": "Search the web with the Example Search API",
  "files": [
    {
      "path": "tools/web-search.ts",
      "content": "import { defineTool } from '@lousho/build-ai-agent';\nimport { z } from 'zod';\n\nexport default defineTool({\n  name: 'web-search',\n  description: 'Search the web',\n  input: z.object({ query: z.string() }),\n  needsApproval: true,\n  execute: async ({ query }) => {\n    const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}`, {\n      headers: { authorization: `Bearer ${process.env.SEARCH_KEY}` },\n    });\n    return response.json();\n  },\n});\n"
    }
  ],
  "permissions": {
    "network": ["api.example.com"],
    "env": ["SEARCH_KEY"],
    "filesystem": "none",
    "exec": false,
    "needsApproval": true
  },
  "dependencies": ["zod"]
}
```

and its entry in `index.json`:

```json
{
  "items": [
    { "name": "web-search", "type": "tool", "description": "Search the web with the Example Search API", "path": "items/web-search.json" }
  ]
}
```

Host both as static files anywhere (a folder in a repository, an object store, a
web server). The document's `name` and `type` must match its index entry, and a
name starts with a letter or digit, followed by letters, digits, `.`, `_` and
`-`. A document that does not match the
format is `LOUSHO_REGISTRY_INVALID`, with the fields named.

To contribute an item to the default registry, add a `registry/<name>/` folder
to the SDK's repository: an `item.json` (`name`, `type`, `description`,
`permissions`, `dependencies`) and the item's files laid out the way they
should land in the agent directory (`tools/x.ts`, `skills/<name>/SKILL.md`,
`channels/x.ts`; a `kit`'s files make up a whole agent directory, e.g.
`agent.json`, `instructions.md`, `hooks.ts`, `tools/`, `subagents/<name>/`).
`npm run registry:build` validates every item against the
same rules `lousho add` enforces (schema, paths, the code/manifest check) and
rebuilds `registry/dist/`; commit the result. CI runs `npm run registry:check`,
which fails when `registry/dist/` is stale.

## Permission manifest

`permissions` declares what the item can do, so you can decide before you
install it. All of it is optional; what is missing is shown as "none" / "no".

| Field | Meaning |
| ----- | ------- |
| `network` | Hosts it calls. |
| `env` | Environment variables it reads. |
| `filesystem` | `none`, `read` or `write`. |
| `exec` | `true` when it runs commands. |
| `needsApproval` | `true` when its tools ask for [approval](./approvals.md) before they run. |

What `lousho add` enforces, before it writes anything:

- **The code matches the manifest.** Every JavaScript and TypeScript file of the
  item is scanned, with comments stripped, for what it visibly reaches for:
  - `exec: true` for an import of `child_process` (with or without `node:`),
    `execa` or `shelljs`, or a use of the SDK's `createShellTool`,
    `runShellCommand` or `SubprocessSandbox`;
  - `filesystem: "read"` (or `"write"`) for an import of `fs` (including
    `fs/promises` and the `node:` forms), `fs-extra` or `graceful-fs`, or the
    SDK's `createFsTools`, and `"write"` for a call to `writeFile`, `appendFile`,
    `createWriteStream`, `mkdir`, `mkdtemp`, `rm`, `rmdir`, `unlink`, `rename`,
    `copyFile` or `cp` (and their `Sync` forms);
  - a non-empty `network` for `fetch(`, a use of the SDK's `createHttpTool`, or
    an import of `http`, `https`, `http2`, `net`, `tls`, `dgram`, `undici`,
    `axios`, `node-fetch` or `ws`, and every `http(s)://` or `ws(s)://` host in a
    string must match a `network` entry (a host built at run time, such as
    `` `https://${host}/` ``, needs a non-empty `network` and is printed as a note,
    since it cannot be checked);
  - every `process.env.NAME` and `process.env['NAME']` must be listed in `env`.

  `eval(`, `new Function(`, a computed `process.env[name]`, `process.env` used as
  a whole, an `import()` or `require()` of anything but a string literal, and
  `require` used as a value (`const r = require`) are
  always refused. A mismatch is `LOUSHO_REGISTRY_MANIFEST_MISMATCH` with every
  finding as `<file>:<line>: <what> (<fix>)`; `--dry-run` reports it too. Markdown
  and other files that are not code (a skill's `SKILL.md`) are not scanned.
  `network` entries must be host names or `*.` wildcards (`api.example.com`,
  `*.example.com` — a wildcard matches subdomains only, not the bare host) and
  `env` entries variable names (`SEARCH_KEY`); anything else
  is `LOUSHO_REGISTRY_INVALID`.
- **Consent covers the elevated permissions.** `exec: true`, `filesystem: "write"`,
  a non-empty `network` and a non-empty `env` are marked `[elevated: ...]` in the
  printed manifest. The interactive prompt lists them before `[y/N]`. With `--yes`
  each one must be named in `--allow` (`--allow network,env` for the example
  above), because `--yes` is how scripts and agents run `lousho add` and should not
  grant command execution silently.
- **A receipt of what was installed.** After writing, `lousho add` updates
  `lousho-registry.json` at the root of the agent directory (next to
  `instructions.md`). Each item's entry has its
  `type`, the `registry` it came from, `installedAt`, the `permissions` and every
  file's `path` and `sha256`, so you can tell later whether a file was edited.
  `--overwrite` replaces the entry; `--dry-run` writes nothing. A receipt that is
  not valid JSON stops the install before any file is written. The receipt is
  what `loadAgentDir` enforces at load and run time (below).

What `loadAgentDir` enforces, from the receipt, when the agent loads and the
item's tools run:

- **Integrity.** Every file the receipt lists is re-hashed. A file that was
  edited or removed since makes its item *unattested*: a warning names the item
  and the changed files, and `resolveAgentDir()` reports the same in
  `manifest.registry` (`status: 'attested' | 'unattested'`, plus the `modified`
  and `missing` paths). Loading is not refused - the files are yours to edit -
  and an unreadable receipt is a warning, not an error.
- **Approval.** The tools of an item declaring `exec: true` or
  `needsApproval: true` - and of any unattested item, whose stale receipt no
  longer certifies the modified code - always wait for
  [approval](./approvals.md); a `deny` from the tool's own `needsApproval`
  still denies. Nothing in the agent directory can waive it: an `allow`
  [permission rule](./approvals.md#permission-policies) and a
  [permission mode](./permission-modes.md) (`acceptEdits`) do not run the call
  (a `deny` rule, `plan` or `dontAsk` still refuses it), and the directory's own
  `approve` file defers it. Only a person resolving the pause
  (`agent.approvals.resolve()`) or an `approve` callback your code passes to
  `loadAgentDir(dir, { approve })` decides it.
- **Sub-agents.** A sub-agent directory inside the installed item (a kit's
  `subagents/<name>/`) is held to the same receipt: its tools are confined
  like the item's other tools, and its own `approve` file defers their
  enforced calls too. A sub-agent's pause has no `approvals.resolve()` handle,
  so the `approve` callback your code passes to `loadAgentDir()` decides them;
  without one the delegated call does not run, and the lead is told that the
  sub-agent stopped for an approval.
- **Network.** While a receipt item's tool runs, `fetch` is limited to the
  hosts its `network` declares: a host the manifest does not list is refused,
  and an item that declares no `network` cannot fetch at all.
- **Environment.** While it runs, `process.env` shows the tool only the names
  `env` declares.
- **Sandboxed tools.** A `requiresSandbox` tool gets a narrowed adapter:
  `run()` is refused without `exec`, `writeFile()` without
  `filesystem: "write"`, and a command's environment is the usual non-secret
  base plus the declared variables only.

The confinement stays at least as narrow as the manifest accepted at install,
attested or not: editing an installed file marks it, asks for approval on its
calls, and widens nothing, until `lousho add <name> --overwrite` installs the
current files and attests them again.

What it does not do: the install-time check reads the code as written, and the
run-time confinement covers only what the SDK can intercept - calls to `fetch`
and `process.env` reads made while the tool runs, and the adapter handed to a
sandboxed tool. Requests through `http`/`net`/`axios`, file access, a reference
captured at module scope (`const f = fetch`), work done when the file is
imported, and a container's own network policy (`SubprocessSandbox`'s
`{ allow }` is a property of the sandbox, not of the item) are all outside it;
so is code that hides what it does (string escapes, aliasing, encoded
payloads, a dependency that does the work) from the static check. Read the
files it lists (`--dry-run` shows them) the way you would read any dependency
before running it.

## Safety rules

- Every `files[].path` must be relative, normalized and forward-slashed: no
  `..`, no absolute path, no drive letter (`C:`), no backslashes, no empty or `.`
  segments. After resolving symlinks it must still be inside the agent directory,
  and a symlink target is never written through.
- A file must be inside the folder its item's type allows: `tool` in `tools/`,
  `skill` in `skills/<name>/`, `channel` in `channels/`, `schedule` in
  `schedules/`, `memory` in `memory/`. A `kit` is the one exception: as a whole
  agent directory its files may sit at any relative path (still normalized and
  inside the target, per the rule above).
- Existing files are not overwritten without `--overwrite`. All files are checked
  before any is written, so a bad item writes nothing. Each of these failures is
  `LOUSHO_REGISTRY_UNSAFE_PATH` or `LOUSHO_REGISTRY_FILE_EXISTS`.
- A file is at most 256 KiB and an item at most 1 MiB; a registry document at
  most 2 million characters.
- Only `http(s)` URLs and local paths are read, with a 15 second timeout per fetch
  (`LOUSHO_REGISTRY_UNREACHABLE` otherwise).
- `dependencies` are printed as an `npm install ...` line for you to run. The
  command never installs packages.

Errors are listed in [Errors](./errors.md#registry). The CLI as a whole is in
[CLI](./cli.md).
