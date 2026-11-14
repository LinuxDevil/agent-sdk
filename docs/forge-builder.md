# The visual builder

The builder is the canvas at the heart of
[Agent Forge](./agent-forge.md): you assemble an agent's graph by dragging
nodes onto a canvas, edit their fields in the Inspector or the Configure
tab, and run the agent in place to watch what it does. Everything it edits
is the same [Agent spec v2](./agent-spec.md) document the rest of the SDK
reads, stored as YAML under `.lousho/agents/`.

This page covers what the builder edits, the canvas and its node kinds,
the Inspector and Configure tab, testing a run without leaving the screen,
the Code tab, and the keyboard shortcuts. For launching Studio and the
other screens see [Agent Forge](./agent-forge.md).

## What the builder edits

An agent's spec lives in `.lousho/agents/<id>.yaml`. Three surfaces edit
that one document and nothing else:

- **The canvas** — nodes and edges are a view of the spec's sections
  (tools, triggers, guardrails, flow steps and so on).
- **The Configure tab** (`#/agents/<id>/configure`) — the same spec as a
  stack of schema-driven forms.
- **The Code tab's YAML view** (`#/agents/<id>/code`) — the spec itself,
  read-only.

Canvas-only state — node positions, which groups are collapsed, sticky
notes and the last viewport — lives in a separate
`.lousho/agents/<id>/layout.json`, so rearranging the canvas never changes
what the agent does. Edits autosave to the working copy; **Save** (or
Ctrl/Cmd+S) additionally writes an entry in the agent's version history —
the **Versions** tab lists them.

## The canvas

The graph is agent-centred: an agent node sits at the centre and the
things it uses — tools, skills, memory, guardrails — attach to it. When
the spec has a `flow`, its steps form a separate chain. An agent with
subagents shows each one as a collapsible group containing that
subagent's own capability nodes.

The left rail's **Nodes** tab is the palette, grouped **Start**, **Agents**,
**Capabilities**, **Safety**, **Output**, **Flow** and **Canvas**. Drag an
entry onto the canvas, or click it (or press Enter on it) to add it at the
centre of the view; `/` jumps to the palette's search. Edges are derived
from the spec — they show what uses what and are not stored separately.

| Node kind | What it sets in the spec |
| --- | --- |
| Trigger | One `triggers[]` entry — chat, a cron schedule, a webhook, a channel (Slack, Telegram, GitHub and more) or another agent finishing. |
| Agent | The agent itself: name, description, model, instructions and the root fields. An inline subagent appears as an agent node inside its group's canvas. |
| Subagent | One `subagents` entry that delegates to another agent in the workspace or to a remote URL. |
| Handoff | One `handoffs[]` entry — passes the conversation to another agent, optionally filtered. |
| Tool | One `tools[]` entry — a built-in, registry, file, integration, OpenAPI or hosted tool. |
| MCP server | One `mcpServers` entry — a stdio or HTTP MCP server whose tools the agent can call. |
| Skill | One `skills[]` entry — instructions loaded on demand from a directory, the registry or inline. |
| Memory | One `memory[]` entry — what the agent remembers across turns, and its scope. |
| Guardrail | One `guardrails[]` entry — checks input or output and can block, warn or rewrite. |
| Permission rule | One `permissions[]` entry — allows, denies, asks or auto-approves tool calls matching a pattern. |
| Hook | One `hooks[]` entry — sandboxed code run before or after a tool call or a model call. |
| Output schema | The agent's `output` — a JSON Schema for a structured result. |
| Abort listener | One `abortListeners[]` entry — cancels runs when a trigger fires. |
| Flow step | One step of `flow` — sequence, router, loop, evaluate, model call, agent step, approval, tool call, set variable or end. |
| Note | Nothing — a sticky comment stored in `layout.json`, never in the spec. |

The toolbar has **Undo**/**Redo**, **Duplicate**, **Auto layout** (an
elkjs pass that repositions the whole graph) and **Fit view**; the
React Flow controls at the bottom-left zoom and fit, and the minimap at
the bottom-right shows the whole graph. `Backspace`/`Delete` removes the
selected nodes; Ctrl/Cmd+D duplicates them.

## Inspector and Configure tab

Click a node and the Inspector on the right opens with its kind, a
**Settings** section of schema-driven fields (the same fields the node's
kind defines — a tool node's picker and options, a trigger's type and
schema fields, and so on), and a **Debug** section for breakpoints while
debug mode is on. A **Problems (n)** section lists everything
`validateGraph` flags for that node; clicking a problem scrolls to and
focuses the offending field. The **View spans** button (enabled once the
node has run) opens the node's spans sheet — see
[Testing in place](#testing-in-place).

Node cards carry small badges: a problem count when validation flags the
node, a pin badge on a tool node whose result is pinned for replay, and an
"edited" chip while an [Author proposal](./forge-author.md) is overlaid on
the canvas.

The **Configure** tab is the spec as a form: eight stacked cards —
Identity, Model, Instructions, Tools, Knowledge, Safety, Triggers, and
Output and limits — generated from the spec's JSON schema, with a sticky
index that marks changed sections and counts issues. A dirty bar at the
bottom shows how many sections changed with **Discard** and **Save**;
**Save** is disabled while the spec has errors. The
`version`, `flow` and `evals` sections are not editable here — flow lives
on the canvas, versions and evals on their own tabs.

The drawer's **Problems** tab lists every graph problem in one table —
severity, node, message and field — errors first; opening a row selects
the node on the canvas.

## Testing in place

The bottom drawer's **Test** tab runs the agent without leaving the
builder. Its run bar shows the run status pill, the provider and model,
a ticking elapsed time, an **Open trace** link once the run reports to
the observe daemon, and a rating control when the run finishes.

While a run is going:

- **Node status overlay** — each card shows its state in the current run:
  a running ring, "awaiting approval" while the run waits on a person,
  done, or failed. Edges leaving a running node animate. Clicking a
  node's status pill opens its spans sheet.
- **Steering** — the box above the composer ("Message the running agent")
  queues a message onto the live run; each message shows whether it was
  **Queued**, **Delivered** or **Undelivered** when the run ended first.
- **Stop** — aborts the run (the button reads "Stopping…" in flight).
- **Inline approvals and questions** — a tool call that needs approval
  shows an approval card ("Approve <tool>?" with its arguments) with a
  "Decide within <time>" deadline; a question from the agent shows its
  options or a free-text answer with an "Answer within <time>" deadline.
  The first answer wins; an expired question resolves as unanswered.

The **spans sheet** (from a node's status pill or its Inspector) lists the
node's spans from the last run — model calls, tool calls, errors, cost —
with an **Open trace** link. On a `tool` node it also offers replay
controls: **Pin this result** records the tool's result so the next run
replays it instead of calling the tool, **Run from here** re-runs the
agent from its newest user message with the pinned results, and each
recorded tool call has **Fork from here**, which opens the replay editor
(forking needs a checkpointed run — see
[Time travel](./agent-forge.md#time-travel)).

## Code tab

`#/agents/<id>/code` shows the spec three ways, generated on demand:

- **TypeScript** — a readable `.ts` rendering of the agent
  (`<id>.agent.ts` on download).
- **YAML** — the spec document itself (`<id>.yaml` on download).
- **Agent directory** — a file-tree preview of the agent's on-disk
  directory.

Every view has **Copy** and **Download** (Download is disabled on the
directory view — copy files one at a time from the tree). The tab is
read-only by design: "Generated from the spec. Read-only — edit on the
canvas or in Configure."

## Keyboard shortcuts

| Keys | Does | Where |
| --- | --- | --- |
| `Ctrl/Cmd+K` | Open the command palette | Everywhere |
| `Ctrl/Cmd+J` | Open or close the Agent Author | Everywhere, even while typing |
| `?` | Show the keyboard shortcuts | Everywhere (not while typing) |
| `Ctrl/Cmd+S` | Save a version of the agent | The builder |
| `Ctrl/Cmd+Z` | Undo the last canvas edit | The canvas |
| `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` | Redo the last undone edit | The canvas |
| `Ctrl/Cmd+D` | Duplicate the selected node(s) | The canvas |
| `Backspace` / `Delete` | Delete the selected node(s) | The canvas |
| `/` | Focus the palette's search | The canvas |
| `j` / `k` / `Enter` | Next / previous / open the selected row | Tables and lists |
| `Esc` | Close the palette, the shortcut sheet, a dialog or the narrow nav drawer | Everywhere |

The `?` sheet lists most of these; Ctrl/Cmd+D, Ctrl/Cmd+Y,
Backspace/Delete and `/` work on the canvas but are not on the sheet.
