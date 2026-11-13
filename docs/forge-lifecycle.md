# Versions, triggers and publishing

Agent Forge keeps an agent's spec as a working copy on disk and grows an
append-only version history beside it. This page covers that lifecycle:
when a version is written, drafts and suggestions, export and import,
templates, the on/off switch and labels, the trigger kinds Studio runs,
the inbox, model-decided approvals, ratings, the publish eval gate,
serving and deploying a published version, and where everything is
stored.

The canvas, Inspector and Author have their own pages —
[the visual builder](./forge-builder.md) and
[the Agent Author](./forge-author.md). For the screens around the agent
detail page see [Agent Forge](./agent-forge.md).

## Working copy, versions and publish

The working copy is `.lousho/agents/<id>.yaml` — the Agent spec v2
document every Studio surface edits. Versions are snapshots of it (plus
the agent's labels) under `.lousho/agents/<id>/versions/`, listed on the
detail page's **Versions** tab.

A version is written when:

- You press **Save** (or Ctrl/Cmd+S). Edits autosave to the working copy
  continuously, but autosave alone never writes a version.
- The Agent Author applies a proposal, a pending draft is approved, or a
  prompt suggestion is applied.
- You restore an old version, import an agent, or create one from a
  template or by copying.
- You publish — publishing first captures the working copy as a
  `publish` version when needed (see
  [Publish and the eval gate](#publish-and-the-eval-gate)).
- The working copy sits unchanged for 60 seconds after the last edit —
  a background "idle" capture makes sure long editing sessions still
  land in history.

Two rules keep history honest:

- **No-op saves write nothing.** A capture whose spec and labels match
  the latest version is skipped, so pressing Save twice does not grow
  the list. The Versions tab calls this out rather than showing a
  duplicate.
- **External edits become `baseline` versions.** If the YAML file changes
  outside Studio (an editor, a script, git), the next Studio read notices
  the file's hash no longer matches what Studio last wrote and captures
  the file's content as a `baseline` version attributed to
  `external_file_edit` — Studio adopts what is on disk instead of
  silently overwriting it.

Every version carries a one-line summary when the background summary pass
has run (it is skipped for restores and baselines). Restoring a version
writes a new `restore` version pointing at the old content — history is
never rewritten — and **never changes the agent's On/Off state**: a
restore of a version saved while the agent was on does not re-enable an
agent you turned off.

## Drafts and suggestions

Studio never lets a background change touch the spec silently. Proposals
from the Agent Author, imports and other sources land as **drafts**: one
pending draft per agent, shown as a "Pending change" card with its
origin, reason, a field-by-field change list, and **Approve**/**Reject**
buttons. Approving writes the spec and a version; rejecting records the
draft in history.

Every draft gets an automatic review pass covering three things:

- **Safety** — a verdict on whether the change looks risky.
- **Routine vs gated fields** — edits to routine fields (instructions,
  description, labels, skills) are skimmable; edits to gated fields
  (model, tools' permissions, triggers, hooks, subagents and anything
  unclassified) are always flagged "Needs your approval". The
  classification fails closed: a spec field nobody classified is gated.
- **Trigger reach** — whether the change alters who or what can start
  the agent.

The verdict is advisory: approving always takes your click, and a
missing model key or a failed review leaves the draft pending and
approvable rather than blocking it. If the agent's spec moves on while a
draft waits, a drift banner appears — "The agent changed since this
draft was made (v3 → v5)" — and approving still applies the draft on top
of the current version.

**Prompt suggestions** are the trace-driven half of the same idea: rate a
run poorly or pick **Suggest a fix**, and a background pass reads the
run's trace and proposes one anchored edit to the agent's instructions.
The proposal is deliberately small — at most 15 changed lines, replacing
an `oldText` segment that must occur exactly once in the instructions.
Applying it is guarded twice: the instructions must still hash to the
`expectedPromptHash` the suggestion was computed against, and the anchor
must still be unique. If either check fails the suggestion is marked
`conflict` instead of corrupting the prompt. Open suggestions appear in
the Inbox and on the agent's **Suggestions** tab.

## Export, import and portability

`GET /agents/<id>/export` offers two formats:

- **`yaml`** — the working-copy spec verbatim, under a Studio-export
  header comment. This is the file to hand to `lousho build`, commit to a
  repo, or diff.
- **`bundle`** — a `lousho.agent-bundle` JSON document: the spec, the
  agent's labels, its registered prompts, and the examples of any eval
  datasets its gates reference, pulled from the observe daemon. Bundle
  prompts the daemon cannot serve degrade to a warning, not a failure.

**Secrets are never exported.** Specs carry secret *references* (a named
secret or an env var), never values; the bundle and the YAML both keep
them as references, so an export is safe to share — but the recipient
must supply the referenced secrets themselves.

`POST /agents/import` (with a preview step first) accepts pasted YAML, a
JSON spec or a bundle — v1 specs are upgraded to v2 on the way in — and
commits in one of three modes:

- **`new`** and **`copy`** create a fresh agent, start it disabled, and
  record a `create` version.
- **`replace`** overwrites an existing agent's spec, keeps its On/Off and
  publish state, and records an `update` version (skipped as a no-op when
  nothing changed).

Before sharing, the **portability check** pass scans the instructions for
machine-specific details — repository names, email addresses, channels,
paths, hosts, pasted secrets — and rewrites them with `[YOUR REPO]`,
`[YOUR EMAIL]`, `[YOUR PATH]`-style placeholders you fill in per
deployment. It needs a model key; without one you can still export, the
check just does not run.

## Templates

The Templates screen (`#/templates`) starts a new agent from a shipped
spec. Six templates ship with Studio:

| Template | What it is for |
| --- | --- |
| `support-triage` | Routes incoming support requests to the right handler. |
| `pr-reviewer` | Reviews pull requests against a checklist. |
| `research-assistant` | Gathers and summarises sources on a topic. |
| `inbox-triage` | Sorts and prioritises an inbox of items. |
| `incident-responder` | Works an incident from alert to mitigation notes. |
| `docs-qa` | Answers questions about a documentation set. |

Creating from a template writes the spec, a `create` version attributed
to `template`, and any tags the template carries become the agent's
labels (subject to the label rules below).

## On, off and labels

Every agent has an **Enabled** switch on its detail header — the UI calls
it On/Off ("On. Triggers can start it." / "Turned off. Triggers won't
start it."). Only *Studio-run* triggers respect it: webhook, cron,
channel and agent-chain dispatch all skip or refuse a disabled agent,
while chat, the test pane and manual runs are unaffected — you can always
talk to an agent that is off.

Turning an agent off also drops its queued trigger runs; a run already in
flight finishes. Turning it back on resumes normal dispatch.

A safety net backs the switch: **five consecutive failed triggered runs
auto-disable the agent** (`disabledReason: 'auto_failure_streak'`), raise
an `auto_disabled` inbox alert, and show an "Auto-off" note explaining
what happened. A triggered run that finishes `done` resets the streak; a
cancelled or manually-run failure does not count.

**Labels** are the Agents list's filter facets. Rules, enforced on every
write (PATCH meta, draft approve, template create): at most **20 labels**,
each at most **32 characters**, trimmed, lowercased, inner whitespace
collapsed and deduplicated. A label that breaks the rules is a 400, not a
silent drop.

## Triggers in Studio

A spec's `triggers[]` list can hold chat (at most one per agent), cron,
webhook, channel and agent entries. Studio mounts and runs all of them
while it is up; the canvas dims non-chat trigger nodes when the agent is
off.

**Webhook** triggers answer `POST /hooks/<agentId>/<path>` where `path`
is the trigger's configured path. With no `secret` configured the route
only accepts loopback calls; with a secret it requires an HMAC signature
— header `x-signature-256: sha256=<hex>` over the raw request body,
checked with a constant-time compare. A bad signature is a 401, an
unknown path a 404, and a successful dispatch answers 202.

**Channel** triggers mount the SDK's channel handlers at
`POST /hooks/<agentId>/channel/<kind>` (plus
`…/channel/<kind>/approvals/<id>` for approval callbacks). Each platform
verifies its own way — Slack's `x-slack-signature`, Telegram's
`x-telegram-bot-api-secret-token`, GitHub's `x-hub-signature-256`, a
Teams JWT, Discord's Ed25519 pair — and every failure answers a uniform
401. An agent can mount at most one trigger per channel kind; a second is
a mount error surfaced on the Overview card. Channel bodies are capped at
1 MB.

**Cron** triggers fire on a schedule with a fixed prompt; per-trigger
fire cursors live in the agent's `triggers/state.json` so a restart does
not re-fire a missed window.

**Agent** triggers chain agents: `{ after, on, promptTemplate }` starts
the target agent when the named agent finishes — `on` is `done`, `error`
or `any`. Chains are capped at **3 agents deep** and cannot cycle: saving
a spec that would loop (A → B → A) or exceed the depth fails with
`LOUSHO_CHAIN_INVALID` (400), and the runtime skips any chain that would
loop anyway. The prompt template can interpolate
`{{run.status}}`, `{{run.resultText}}` (capped at 8000 characters) and
`{{run.traceId}}`.

**Abort listeners** are the inverse: `abortListeners[]` entries watch
webhook and channel triggers only (at most 20) and cancel queued or
running runs when an event matches. Each entry has `triggerId` (which
trigger's runs are candidates), `when` and `match` (safe expressions over
the event — and for `match`, the candidate run — that must evaluate to
strictly `true`), and `scope` (`queued`, `running` or `both`). Every
inbound webhook or channel event evaluates all of the agent's listeners
*before* that event's own filter and dispatch, so a listener can cancel
the very run the event would have started — but never itself, since the
delivering run does not exist yet. Chat and cron events do not evaluate
listeners.

## Inbox

The **Inbox** screen (`#/inbox`) collects everything waiting on you across
agents, and the nav badge counts open items. Rows come in five kinds:

- **approvals** and **questions** — a run paused for a tool-call decision
  or an `ask_question`; they expire, and the row carries the countdown.
- **drafts** — pending change drafts (see above), with gated-field flags.
- **suggestions** — open prompt-edit suggestions.
- **alerts** — `auto_disabled` (the failure streak), `publish_failed`
  (the eval gate refused a publish), and `low_rating` (a run rated 2 or
  lower).

Alert rows act inline: a `low_rating` alert offers **Add to dataset
`<agentId>-regressions`** (copies the trace into the agent's regression
dataset), **Suggest a fix** (starts the prompt-suggestion pass on that
trace) and **Dismiss**; the other alerts offer **Dismiss**. Approval and
question rows answer in place.

## Approvals decided by a model

A permission rule's `action` can be `allow`, `deny`, `ask` or `auto`.
`auto` compiles to `ask` and is then decided by a cheap model scoring the
*exact* tool call about to run: it sees the call and its arguments, not
the agent's general behaviour.

The rule is deliberately one-directional:

- A safety score **≥ 0.8** returned **within 8 seconds** approves the
  call.
- A lower score, a timeout, an error or a truncated reply does not deny —
  it **escalates to you**, and the run pauses for a normal approval.
- The model can never deny on its own, and the approval binds to that
  exact call: a different call asks again.

## Ratings

Runs, traces and test runs carry a 1–5 rating (Poor, Fair, Good, Great,
Excellent). `POST /agents/<id>/rating` records it as a `rating` score on
the run's trace in the observe daemon — the same place eval datasets and
traces live — and a rating of **2 or lower** also raises a `low_rating`
inbox alert (see above). From the alert you can copy the trace into the
agent's `<agentId>-regressions` dataset or start a prompt suggestion on
it, which is how a bad run becomes a regression test or a prompt fix.

## Publish and the eval gate

The publish pill on the builder pins a version as the agent's *live*
spec — the version triggers, Serve and Deploy run. `POST
/agents/<id>/publish` accepts an optional `{ "version": n }`; without it
the working copy is captured as a `publish` version first (skipped when
nothing changed, so an unchanged agent just re-pins the latest).

When the target version's spec declares `evals`, the **eval gate** runs
each dataset's examples through the candidate version before the pin
lands:

```yaml
evals:
  - dataset: support-triage-gold
    minPassRate: 0.8
    gates:
      - calledTool: lookup_order
      - notCalledTool: delete_account
      - maxCostUsd: 0.05
      - maxSteps: 12
      - judge:
          model: anthropic/claude-haiku-4-5
          rubric: The answer cites the order status and offers a next step.
          minScore: 0.7
```

Each entry names an observe `dataset` (up to 50 examples are fetched,
each run capped at 60 seconds), 1–20 `gates` every example must pass, and
a `minPassRate` (0–1) of examples that must pass for the set to count. A
spec may carry up to 20 eval entries. Gate kinds:

- `calledTool` / `notCalledTool` — the run's tool calls must (not) include
  the named tool.
- `maxCostUsd` / `maxSteps` — bounds on the run's cost and step count.
- `judge` — a model grades the answer against a `rubric` and must reach
  `minScore` (0–1).

A passing gate pins the version and reports the publish. A failing one
answers **409 `LOUSHO_EVAL_GATE_FAILED`** with the full per-set result —
pass rates, failing examples (first 10 shown, then "+n more") with their
failure sentences and `Open trace` links — and Studio shows the "Eval
gate failed" dialog ("v3 was not published. Fix the failures or change
the gate, then publish again."). There is no "publish anyway". The
captured `publish` version stays in history, simply unpinned, and a
`publish_failed` inbox alert is raised. A second publish while a gate is
running answers 409 `LOUSHO_EVAL_GATE_BUSY`.

## Serve while Studio runs

With a version published, the **Serve** card on the Code tab exposes the
agent over HTTP while Studio runs: `POST <origin><baseUrl>/chat`, an SSE
stream of the run's events. Enable it with the "Serve the published
version" switch — it stays disabled until something is published.

Callers authenticate with a **bearer token**: 32 base64url characters,
shown masked (first four and last four) in the card. Reveal shows it for
30 seconds; copy puts it straight on the clipboard; rotate invalidates the
old one everywhere, including a running MCP server (which restarts on a
new port). Treat the token like a password — anyone holding it can run
the agent, spend its budget and see its sessions. Keep it server-side;
never commit it or put it in client-side code.

**Allowed origins** is the CORS list for browser callers, one origin per
line (e.g. `http://localhost:3000`). Empty means server-side callers
only. Requests from an unlisted `Origin` get no CORS headers — and the
chat widget refuses them outright.

```bash
curl -N http://127.0.0.1:41234/serve/my-agent/chat \
  -H "Authorization: Bearer $LOUSHO_SERVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo","input":"Hello"}'
```

Serve routes enforce a loopback `Host` check: they answer only requests
addressed to Studio's own host. The snippets assume Studio on
`127.0.0.1` — if you started it with `--host`, substitute the real host
in the endpoint, the MCP URL and the widget snippet.

**MCP**: the card can also start the published agent as an MCP server on
an ephemeral loopback port. Add it to Claude Code with:

```bash
claude mcp add --transport http my-agent http://127.0.0.1:41234/mcp \
  --header "Authorization: Bearer $LOUSHO_SERVE_TOKEN"
```

(The card prints the exact command with the live URL.) For a server that
outlives Studio, the stdio form runs the published snapshot directly —
`lousho mcp .lousho/agents/<id>/published.yaml` — which exists once the
agent has been published (a deploy also writes it).

**Embeddable chat**: the widget bundle is served at
`<baseUrl>/widget.js` and mounts a `<forge-chat>` element. It uses a
separate **widget key** (`fwk_…`) that is narrower than the serve token —
it can only call chat, and only from an origin on the allowed-origins
list (a page elsewhere gets 403 `LOUSHO_WIDGET_ORIGIN`). Embed it with:

```html
<script src="http://127.0.0.1:41234/serve/my-agent/widget.js" defer></script>
<forge-chat endpoint="http://127.0.0.1:41234/serve/my-agent/chat" token="fwk_YOUR_KEY" title="my-agent"></forge-chat>
```

The widget derives its endpoint from `location.origin`, so the snippet's
host must be the Studio host the visitor's browser can reach — the
loopback default works for local demos, not for a public site.

## Deploy

**Deploy** (Settings → Deploy, or the deploy section) builds the
*published* version into a runnable artifact — never the working copy.
Publishing writes `.lousho/agents/<id>/published.yaml`, the snapshot
deploy consumes, and deploy runs the real CLI:

```
node bin/lousho.js build --target=<adapter> --agent=<published.yaml> --out=<baseDir>/.lousho/build/<adapter>/<id>
```

Three adapters ship: `node-server`, `cloudflare-worker` and `docker`.
Deploying an agent with nothing published answers 409
`LOUSHO_NOT_PUBLISHED` — "Publish a version before deploying".

One caveat worth knowing: `published.yaml` holds the spec's **v1
projection**, not the raw v2 document, because `lousho build` and
`lousho mcp` still load spec files through the v1 loader. A v2-only
field that does not project into v1 will not reach the deployed artifact.

## Where things are stored

Studio state lives under the workspace's `.lousho/` directory. Per agent,
`.lousho/agents/<id>/` is a sidecar folder next to the spec:

```
.lousho/
  agents/
    <id>.yaml                     # the spec v2 working copy
    <id>/
      meta.json                   # enabled, disabledReason, failureStreak, labels, publish pointer, createdFrom
      layout.json                 # canvas positions, collapsed groups, notes, viewport
      working.json                # Studio-write marker (spec hash) for external-edit detection
      published.yaml              # v1 projection of the published version (deploy/mcp/serve)
      versions/
        index.jsonl               # one line per version, newest facts first
        000001.json …             # full snapshots (spec + labels)
      drafts/
        current.json              # the one pending draft
        history/<draftId>.json    # resolved drafts
      suggestions/<id>.json       # prompt-edit and portability records
      triggers/state.json         # cron fire cursors
      checkpoints/<sessionId>.json        # resumable run state
      checkpoint-history/<sessionId>.json # finished checkpoints
      approvals/<approvalId>.json        # paused tool-call decisions
  passes/spend.jsonl              # append-only pass model spend log
  inbox/alerts.json               # auto_disabled / publish_failed / low_rating records
  serve.json                      # per-agent serve switches, tokens refs, allowed origins
  secrets.json                    # encrypted provider keys and named secrets
  secrets.key                     # the encryption key for secrets.json
  workspaces.json                 # the workspace registry
  settings.json                   # settings profiles
  assistant/sessions/             # Agent Author session files
```

`versions/` is append-only: the full record is written before its
`index.jsonl` line, so a crash mid-capture cannot leave a dangling index
entry. Pass records — version summaries, draft reviews, portability
checks, prompt suggestions, eval judges, auto-approvals — write their
results back onto the draft, suggestion or version they belong to, and
their model spend lands in `passes/spend.jsonl`.
