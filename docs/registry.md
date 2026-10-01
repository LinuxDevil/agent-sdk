# Registry

`loushy add` installs a tool, skill, channel, schedule or memory slot into an
[agent directory](./agent-directories.md) from a registry. A registry is plain
static JSON: an index plus one document per item that carries the file contents.
The files are copied into your project as source you own and can edit. There is
no runtime plugin loader, and nothing from a registry is executed or imported
while adding it.

There is no hosted registry yet. Point `loushy add` at one with `--registry` or
the `LOUSHY_REGISTRY` environment variable; without either it fails with
`LOUSHY_CONFIG_INVALID` and says how to pass one.

```bash
loushy add --list --registry ./registry/index.json
loushy add web-search --registry https://example.com/registry/index.json --dir ./my-agent
LOUSHY_REGISTRY=./registry/index.json loushy add web-search --dry-run
```

| Flag | Meaning |
| ---- | ------- |
| `--registry <url-or-path>` | The index: an `http(s)` URL or a local path (`LOUSHY_REGISTRY` when absent). |
| `--dir <agent-dir>` | The agent directory to write into (default: the current directory; it must exist). |
| `--yes`, `-y` | Do not ask for confirmation. Required when stdin is not a terminal. |
| `--overwrite` | Replace files that already exist (without it an existing file is `LOUSHY_REGISTRY_FILE_EXISTS`). |
| `--dry-run` | Print the manifest and the files, write nothing, exit 0. |
| `--list` | Print the registry's items and exit. |

Before it writes anything, `loushy add` prints the permission manifest and the
files it will write, then asks `[y/N]`.

## Format

The index is `{ items: [{ name, type, description, url | path }] }`. `type` is
`tool`, `skill`, `channel`, `schedule` or `memory`. `url` / `path` locate the
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
      "content": "import { defineTool } from '@loushy/build-ai-agent';\nimport { z } from 'zod';\n\nexport default defineTool({\n  name: 'web-search',\n  description: 'Search the web',\n  inputSchema: z.object({ query: z.string() }),\n  needsApproval: true,\n  execute: async ({ query }) => {\n    const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}`, {\n      headers: { authorization: `Bearer ${process.env.SEARCH_KEY}` },\n    });\n    return response.json();\n  },\n});\n"
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
name is letters, digits, `.`, `_` and `-`. A document that does not match the
format is `LOUSHY_REGISTRY_INVALID`, with the fields named.

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

The manifest is what the author says the code does. It is not enforced by the
SDK and not a sandbox: read the files it lists (`--dry-run` shows them) the way
you would read any dependency before running it.

## Safety rules

- Every `files[].path` must be relative, normalized and forward-slashed: no
  `..`, no absolute path, no drive letter (`C:`), no backslashes, no empty or `.`
  segments. After resolving symlinks it must still be inside the agent directory,
  and a symlink target is never written through.
- A file must be inside the folder its item's type allows: `tool` in `tools/`,
  `skill` in `skills/<name>/`, `channel` in `channels/`, `schedule` in
  `schedules/`, `memory` in `memory/`.
- Existing files are not overwritten without `--overwrite`. All files are checked
  before any is written, so a bad item writes nothing. Each of these failures is
  `LOUSHY_REGISTRY_UNSAFE_PATH` or `LOUSHY_REGISTRY_FILE_EXISTS`.
- A file is at most 256 KiB and an item at most 1 MiB; a registry document at
  most 2 million characters.
- Only `http(s)` URLs and local paths are read, with a 15 second timeout per fetch
  (`LOUSHY_REGISTRY_UNREACHABLE` otherwise).
- `dependencies` are printed as an `npm install ...` line for you to run. The
  command never installs packages.

Errors are listed in [Errors](./errors.md#registry). The CLI as a whole is in
[CLI](./cli.md).
