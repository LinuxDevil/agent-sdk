# Claude Code projects

A repository that already carries Claude Code's conventional files —
`CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, `.claude/rules/`,
`.claude/scratchpad/` — loads them with `claudeProject()`: the result spreads
into `createAgent()`, so the same directory drives both harnesses. Nothing is
copied or renamed; Lousho reads the files where they already are.

```ts no-run
import { createAgent, claudeProject } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const provider = mockModel([{ text: 'ok' }]);

const project = await claudeProject('./my-repo', { provider });
const agent = createAgent({ provider, ...project });
```

What maps to what:

| Claude convention | Becomes |
| ----------------- | ------- |
| `CLAUDE.md` (and `AGENTS.md`) | `instructions` (concatenated when both exist) |
| `.claude/rules/*.md` | appended instruction sections, `## <file>`, sorted by name |
| `.claude/skills/<name>/SKILL.md` | `skills` — same layout [`loadSkills()`](./skills.md) already reads |
| `.claude/agents/*.md` | `subagents`: frontmatter `name`/`description`/`model`, body = instructions |
| `.claude/scratchpad/` | a `scratchpad` tool — `write`/`append`/`read`/`list` named notes in that dir |
| `.claude/commands/`, `settings*.json`, `mcp.json` | not loaded — listed on `manifest.ignored` |

## Sub-agents

`.claude/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews diffs for correctness
model: openrouter/openai/gpt-4o-mini
---

You review code ruthlessly. Report findings, never rewrite.
```

The frontmatter `name` and `description` are required (Claude Code's own
contract); the body becomes the sub-agent's `instructions`. `model` selects
the sub-agent's model; without it the sub-agent runs on the `provider` /
`model` passed to `claudeProject()` — a file with neither is an error naming
it. A `tools` frontmatter list is recorded on the manifest but not enforced:
Lousho sub-agents share the lead's tool registry (narrow them with
[permission rules](./approvals.md#permission-rules) instead).

Unlike [agent directories](./agent-directories.md), `claudeProject()` *reads
markdown as data and runs nothing*: no file in `.claude/` is imported or
executed. Loading a project you don't trust is therefore safe — the tool
surface stays whatever you pass to `createAgent()`.

## Scratchpad

`.claude/scratchpad/` gets a `scratchpad` tool: the agent writes, appends,
reads and lists `*.md` notes in that directory (names are `a-z0-9-_`, so
paths can't escape it). It is the durable "working notes" surface — for
secrets or structured facts prefer [memory slots](./memory.md); for
task-shaped notes, hooks can pause on `scratchpad` writes like any tool.

## Options

```ts no-run
import { claudeProject } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const provider = mockModel([{ text: 'ok' }]);

await claudeProject('./repo', {
  provider,            // sub-agents without a frontmatter model run on this
  model: 'openai/gpt-4o', // ...or on this model id (frontmatter model wins)
  scratchpad: true,    // return the tool even if .claude/scratchpad is absent (created on first write)
  rules: false,        // skip .claude/rules
  agents: false,       // skip .claude/agents
});
```

`manifest` reports what was found: `instructionFiles`, `rules`, `skills`,
`subagents`, `scratchpad`, `ignored`.

## What's deliberately not loaded

`.claude/commands/*.md` are slash-command prompts for an interactive harness —
the Lousho shape for "named repeatable workflows" is [flows](./flows.md).
`.claude/settings*.json` are Claude Code harness settings (they don't describe
an agent), and `.claude/mcp.json` declares MCP servers — pass those to
`createAgent({ mcpServers })` yourself ([MCP](./mcp.md)); parsing a
third-party config format is deliberately out of scope.

For the other direction — `projectInstructions: true` on `createAgent()` —
finds and appends the nearest `AGENTS.md`/`CLAUDE.md` up the tree, without
touching `.claude/`. See the option in [Configuration](./configuration.md).
