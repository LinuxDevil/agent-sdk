# CLI

Installing the package also installs the `loushy` command. It scaffolds
projects, checks your setup, runs an agent locally, serves it over MCP, runs
evals, builds a deployable artifact and launches the Agent Forge dashboard.
Run it with `npx loushy <command>` inside a project that has the SDK installed.

| Command | What it does | Details |
| ------- | ------------ | ------- |
| `loushy init [dir]` | Scaffold a project: an agent with an example tool, an offline test, `.env.example`; installs dependencies and runs `git init`. | [Installation](./installation.md#scaffolding-a-new-project) |
| `loushy doctor [spec] [--json]` | Check Node, peer packages, provider keys, and optionally a spec file; prints a fix for every problem. | [Installation](./installation.md#troubleshooting-loushy-doctor) |
| `loushy dev <spec>` | Local dev server for a spec file: chat UI, `POST /chat`, hot reload on save. | [Below](#loushy-dev) |
| `loushy mcp <spec>` | Serve the agent as an MCP server (stdio, or HTTP with `--http`). | [Configuration](./configuration.md#serve-an-agent-over-mcp) |
| `loushy eval [globs...]` | Run `*.eval.ts` files under vitest; print a summary and write JUnit/JSON reports. | [Evals](./evals.md#loushy-eval) |
| `loushy build --target=<t> --agent=<spec>` | Build a deployable Node server, Docker image or Cloudflare Worker. | [Deployment](./deployment.md) |
| `loushy studio` | Launch Agent Forge, the visual dashboard, on one local port. | [Agent Forge](./agent-forge.md) |

Every command that takes a `<spec>` reads an agent spec file (`.yaml`,
`.yml` or `.json`, see [Configuration](./configuration.md#agent-spec-files-agentspec)).

## Usage

```text
loushy init [dir] [--provider P] [--template T] [--yes] [--no-install] [--no-git] [--package-manager PM] [--force]
loushy dev <config.yaml|config.json> [--port N] [--host H]
loushy build --target=<name> --agent=<path> [--out=<dir>]
loushy studio [--port N] [--host H] [--prod|--dev]
loushy mcp <agent.yaml|json> [--http --port N --host H]
loushy doctor [agent.yaml|json] [--json]
loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--record | --replay | --drift [--drift-usage]]
```

`npm create loushy-agent my-agent` runs `loushy init` with the same arguments.
While the package is not on npm, scaffold from a checkout of this repository
with `node bin/loushy.js init my-agent --sdk-path .` (see
[Installing from a local build](./installation.md#installing-from-a-local-build)).

## `loushy dev`

```bash
npx loushy dev agent.yaml
npx loushy dev agent.yaml --port 4000 --host 0.0.0.0
```

Serves `GET /` (a chat UI), `GET /health` and `POST /chat`
(`{ "message": "..." }`, 1MB body limit). The agent is reloaded whenever the
spec file changes, and the last good config is kept if an edit is invalid.

- `--port` - default `3737`.
- `--host` - default `127.0.0.1` (localhost only). Pass e.g. `--host=0.0.0.0`
  to opt in to LAN access.

## `loushy build`

```bash
npx loushy build --target=node-server --agent=agent.yaml        # or docker / cloudflare-worker
```

Writes the artifact to `--out` (default `.loushy/build/<target>`) and prints
the command to run or deploy it. Building needs `tsup`
(`npm install --save-dev tsup`). Targets, the HTTP API they serve and the
Workers limits are in [Deployment](./deployment.md).

## `loushy studio`

```bash
npx loushy studio            # http://127.0.0.1:4750
npx loushy studio --port 5000
```

Starts one local server for the Agent Forge API and UI. Agents and run state
are stored under `.loushy/` in the current directory. See
[Agent Forge](./agent-forge.md) for the walkthrough.
