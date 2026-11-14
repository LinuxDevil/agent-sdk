# The Agent Author

The Agent Author is a chat panel in [Agent Forge](./agent-forge.md) that
drafts agents and changes to them. Describe what you want in plain words;
it reads your workspace's agents, specs and catalogs, and answers with
**proposals** — cards that show exactly what would change. Nothing is
written until you apply a card, and even then a new agent is saved switched
off until you enable it.

This page covers opening the Author, how proposals and the save gate
work, the tools it can call, secrets, the draft review, its settings, and
the eval that measures it.

## Open the Author

- **Ctrl/Cmd+J** toggles the panel, from anywhere — even while typing in a
  field. The nav rail's **Agent Author** button and the command palette's
  **Open Agent Author** do the same.
- **Describe with AI** on the agents list, **Describe it to the Agent
  Author** on an agent's empty canvas, and **Change with AI** on an
  agent's header all open it with the right focus already set.
- A **focus chip** above the composer shows what the Author is working on:
  **New agent**, or **Editing: \<agent id\>** for the agent you are
  viewing. Its clear button ("Start a new agent instead") drops the edit
  focus.
- A new chat starts on "What should we build?" with a few suggestion
  buttons; **New chat** and **Chat history** sit in the panel header.

The Author runs on a model, so it needs a provider key like any other
feature: with none configured the panel shows "Add an API key to use the
Agent Author" with a link to Settings (see [Settings](#settings)).

## Proposals, not writes

Every change the Author wants to make comes back as a proposal card in
the chat — the model's own tools cannot write an agent directly.

- A **new agent** card is headed "New agent" with the proposed name and
  its enabled state; an **update** card is headed "Change" and lists
  "What changes · n fields" — a field-by-field diff of the spec (added,
  removed and edited fields, with the instructions as a line diff).
  **Show full configuration** expands the whole proposed spec.
- **Nothing is written until you apply.** The card's **Save agent** (new)
  or **Apply changes** (update) button is the only way a proposal becomes
  an agent; **Saving…** shows while the write is in flight. The Author
  can also save in a later turn once you have confirmed — the same gate
  applies.
- While an update proposal is open, the canvas shows the proposed graph
  read-only: proposed additions, changes and removals draw as dashed
  nodes, a banner counts them ("Showing a proposed change: a added, e
  changed, r removed."), and a toolbar pill ("Proposed change · review in
  the Author") jumps back to the card, and the banner's **Hide** button
  dismisses the overlay so you can edit the real graph again.
- A card can fold in your earlier unsaved proposals for the same agent;
  it says so ("Your earlier change was never saved, so it is included
  here…") and applying saves everything shown.
- Cards list **requirements** — missing provider keys, secrets, MCP
  servers or tools — each with a fix button (**Add secret**, **Open
  Settings**, **Check**). They never block a save; a new agent just stays
  off until they are met.

If a save is refused, the card says why in plain words — for example
"A newer proposal replaced this one, and only the newest proposal can be
saved." or "This agent changed after the proposal was made." The full set
of refusals is enforced in code: an unknown, stale, discarded, already
saved or wrong-agent proposal, a proposal from the current unanswered
turn, or one that no longer passes the spec schema.

After a save the canvas reloads with the new version ("Canvas updated
with the Author's change."); if you have unsaved edits of your own it
warns first and offers **Reload**.

## What it can do

The Author's tools fall into three groups: reads of your workspace and
catalogs, proposals and gated writes, and a few client-side actions. It
cannot run or edit anything else.

| Tool | What it does |
| --- | --- |
| `getCurrentSpec` | Read an agent's saved spec, enabled state and latest version. |
| `listAgents` | List the workspace's agents with name, description and enabled state. |
| `listModels` | The model catalog with capabilities and which providers have a key. |
| `listTools` | The built-in tools an agent can call. |
| `listGuardrails` | The guardrail types and their option schemas. |
| `listTriggerTypes` | The trigger types and the fields each takes. |
| `listSkills` | The skills available to attach. |
| `listKits` | The kits (bundled agent parts) available. |
| `listTemplates` | The agent templates that can seed a new agent. |
| `listMcpServers` | MCP servers configured in any agent plus registry entries — secret fields reduced to key names. |
| `probeMcpServer` | Connect to an MCP server spec and list the tools it exposes. |
| `searchDocs` | Search the bundled SDK docs and return matching excerpts. |
| `getTrace` | Read a run's trace as condensed steps with cost. |
| `runDraft` | Run the agent's saved working copy once (60-second cap) and report the result — it cannot run an unsaved proposal. |
| `openPage` | Navigate the Studio to one of its screens. |
| `proposeAgent` | Return a proposal card for a new agent. Writes nothing. |
| `proposeAgentUpdate` | Return a proposal card patching an existing agent. Writes nothing. |
| `saveAgent` / `saveAgentUpdate` | Save the newest confirmed proposal — gated: refused unless you have seen and confirmed the card. |
| `discardPendingChanges` | Drop unsaved proposal cards; never touches saved agents. |
| `setAgentEnabled` | Switch an agent on or off — only when you explicitly asked for it in the same message. |
| `requestSecret` | Ask you for a secret value in a card (see [Secrets](#secrets)). |

## Secrets

When a draft needs a key — an MCP server's token, a provider key — the
Author calls `requestSecret`, and a card appears in the chat: "Enter
\<name\>", a password field, **Save secret** and **Skip**. The value goes
straight to Studio's secrets store on this machine; it never lands in the
chat transcript, the stream or browser storage, and the Author itself
never sees it — the tool only learns that the name is set. Provider key
names that belong in Settings (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
the like) are refused here and pointed at Settings instead. Skipping is
fine: the proposal still saves, and the requirement row stays until the
secret exists.

## Review before you see a card

Before a proposal card reaches you, a second, smaller model gives the
draft a once-over — five yes/no questions:

1. **runs** — can this agent run as configured (catalog ids valid, MCP
   servers reachable, no literal secrets)?
2. **fulfillsIntent** — does the draft do what you asked?
3. **toolsComplete** — does every step in the instructions have a way to
   happen?
4. **guardrailsFit** — do the guardrails and approvals fit the risk?
5. **triggersFit** — do the triggers match when you want the agent to run?

A "no" sends the draft back to the Author to fix, for at most three
rounds; after that the card is shown anyway. The check fails open — an
unavailable review model, a timeout or a missing verdict all pass — and
you never see it: it is not mentioned in the chat.

## Settings

`#/settings` has an **Agent Author** card: the **Author model** (default
`anthropic/claude-sonnet-5-5`) that writes proposals, the **Review model**
(default `anthropic/claude-haiku-5-5`) that checks each draft, and a
**Review drafts** switch to turn the check off. The card's pill shows
**Ready** or **Needs a key** (with **Add key** jumping to Provider keys);
models without a configured key are listed but disabled.

## Evaluating the Author

The Author ships with a scenario eval in the SDK repo:
`npm run eval:author -w apps/agent-forge` runs the scripted scenarios in
`apps/agent-forge/evals/author/scenarios/` through the real server path —
hard checks (including safety checks such as ignoring pasted
credentials) plus a rubric judged by the review model. Useful flags:
`--mock` for a scripted pass with no rubric, `--only <names>` for a
subset, `--no-review` to skip the draft review, and `--update-baseline`
to record the run's pass rate as the new baseline.

Results land in `evals/author/results/<date>.json` (not committed). A run
fails when its pass rate drops more than 5 points below
`evals/author/baseline.json`, when any scenario errors, or when a safety
check fails; a missing baseline passes until you write one with
`--update-baseline`.
