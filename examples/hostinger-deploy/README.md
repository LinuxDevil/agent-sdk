# hostinger-deploy

Deploy a Lousho agent to a real VPS: `agent/` is an agent directory for a
small ops assistant (`vps-ops`), and `deploy.mjs` builds it with
`lousho build --target=docker`, ships the context over SSH, and runs the
container on a Hostinger virtual machine.

| Piece | What it uses |
|---|---|
| The agent | agent directory (`agent.json` + `instructions.md` + `tools/host.ts`) loaded by the built server |
| The build | `lousho build --target=docker` (bundled `dist/server.js` + `Dockerfile`) |
| VM discovery | Hostinger API `GET /api/vps/v1/virtual-machines` — the same API the `hostinger-vps` MCP server wraps |
| The ship | `tar` + `scp` + `ssh` (needs SSH access to the VM — an attached public key) |
| Durability | `LOUSHO_STORE=sqlite:/data/lousho.db` on a `lousho-data` volume — sessions and approvals survive container restarts |
| Auth | `LOUSHO_API_TOKEN` bearer on every route except `/health` |

## What it deploys

`vps-ops` answers operator questions about the host it runs on: `host_status`
(OS, uptime, load, memory) is live facts, and a small scratchpad
(`write_note`/`read_note`/`list_notes`) persists operator notes — writes ask
for approval, reads are always allowed. The model is
`openrouter/openai/gpt-4o-mini`.

## Run it

```bash
export HOSTINGER_API_TOKEN=...   # Hostinger API token (developers.hostinger.com)
export OPENROUTER_API_KEY=...    # the agent's model key
export LOUSHO_API_TOKEN=...      # bearer token protecting the deployed server
node examples/hostinger-deploy/deploy.mjs --vm 1924068   # id, hostname or IPv4
```

The script verifies the VM is running, builds the docker target locally,
copies the context to `/opt/lousho-agent`, builds and (re)starts the
`lousho-agent` container on port 3000, then polls `/health` and sends one
`/chat` round-trip. It only touches the `lousho-agent` container — VM
provisioning, recreates and billing ops are intentionally out of scope (use
the Hostinger API/console for those).

After deploy:

```bash
curl -N http://<ip>:3000/chat \
  -H "Authorization: Bearer $LOUSHO_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId": "me", "input": "What is the load?"}'
```

Port 3000 is plain HTTP — put Traefik (installed on the VPS template) or
another TLS terminator in front for anything real, per
[the deployment docs](https://github.com/LinuxDevil/agent-sdk/blob/main/docs/deployment.md).
