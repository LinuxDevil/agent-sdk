# Lousho Studio

A local web app for building, testing and watching every agent across your
projects — powered by [`@linuxdevil/lousho`](https://www.npmjs.com/package/@linuxdevil/lousho).

## Install & run

```sh
npx @linuxdevil/studio            # open Studio on the current folder
npx @linuxdevil/studio --workspace ~/code/my-app --port 5000
```

Or install it globally and use the `lousho-studio` command:

```sh
npm i -g @linuxdevil/studio
lousho-studio --workspace ~/code/my-app
```

If your project already has the SDK, `lousho studio` (from
`@linuxdevil/lousho`) launches the same app.

Studio prints a URL with a per-launch token — every API and WebSocket
request needs it, so keep the URL private to your machine (it binds to
`127.0.0.1` by default; pass `--host` to change that).

## Workspaces

A **workspace** is a project folder. Studio reads and writes each workspace's
agents under its `.lousho/` directory, so one Studio instance can follow many
projects. `--workspace <dir>` opens that folder and adds it to your workspace
list; the first run uses the current folder.

Runs use the project's own SDK when the workspace has `@linuxdevil/lousho`
installed, so Studio works across SDK versions. See
[Agent Forge](https://lousho.com/agent-forge) for the full guide.

## Options

```
Usage: lousho-studio [--workspace <dir>] [--port N] [--host H]

  --workspace <dir>  a project folder to open (default: the current folder)
  --port N           the port (default 4750)
  --host H           the interface to listen on (default 127.0.0.1)
  -v, --version      print the version
  -h, --help         show this help
```

## Requirements

Node.js >= 22.19. Provider API keys are configured inside Studio's Settings;
no keys are needed to open the app.
