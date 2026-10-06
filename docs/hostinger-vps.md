# Deploying to a Hostinger VPS

The `docker` [deployment](./deployment.md) target is a plain Dockerfile +
bundled server, so it runs on any Docker host — including a Hostinger VPS.
The [hostinger-deploy](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/hostinger-deploy)
example ships a complete, tested recipe: `deploy.mjs` verifies the VM through
the Hostinger API, builds locally, ships the context over SSH, and runs the
container — then proves the deploy with `/health` and one real `/chat` turn.

```bash
export HOSTINGER_API_TOKEN=...   # developers.hostinger.com -> API tokens
export OPENROUTER_API_KEY=...    # the agent's model key
export LOUSHO_API_TOKEN=...      # bearer protecting the deployed server
node examples/hostinger-deploy/deploy.mjs --vm <id|hostname|ip>
```

What it does, step by step:

1. **Verify the VM.** `GET /api/vps/v1/virtual-machines` finds the VM by id,
   hostname or IPv4 and refuses non-`running` machines. The
   `hostinger-api-mcp` MCP server wraps this same API, so an agent (or this
   session) can also drive it interactively — VM lifecycle, SSH keys,
   firewall rules, post-install scripts.
2. **Build.** `lousho build ./agent --target=docker --out <dir>` produces a
   self-contained context (bundled `dist/server.js`, `Dockerfile`).
3. **Ship + run.** `tar`/`scp` the context to `/opt/lousho-agent`, then over
   SSH: `docker build`, `docker rm -f lousho-agent` if it exists, and
   `docker run -d --restart unless-stopped -p 3000:3000 -e ...`.
4. **Prove it.** Poll `/health`, then POST one `/chat` turn with the bearer
   token.

The example's environment flags are worth copying:

- `-e LOUSHO_STORE=sqlite:/data/lousho.db -v lousho-data:/data` — sessions and
  paused approvals survive container restarts (`/data` is a named volume).
- `-e LOUSHO_API_TOKEN=...` — required: every route except `/health` is then
  bearer-authed. Port 3000 is plain HTTP; put Traefik (the VPS template
  installs it) or another TLS terminator in front.

Provisioning itself — purchasing, recreating, resizing a VM — is deliberately
*not* in the script: those are billed or destructive Hostinger API calls best
left to explicit ops (or the MCP server, where each call is visible).
