# Skills

A skill is a named chunk of instructions (a markdown document) that the model
loads **only when it needs it**. This is progressive disclosure: instead of
pasting every playbook into the system prompt, you list skills by name and
one-line description, and the model pulls in the full text on demand.

How it works when an agent has skills:

1. The system prompt gets a compact **Available skills** block: one line per
   skill (`- name: description`) plus one sentence telling the model to call
   `load_skill` before doing a task a skill covers.
2. A `load_skill` tool (input `{ name }`) is registered automatically. It
   returns the skill's full content as the tool result.
3. Skill bodies are **not** in the prompt until loaded. An agent with twenty
   long skills pays roughly one line per skill on every request, and the body
   cost only on the runs that use it.

An unknown name is a tool error that lists the valid skill names, so the model
can correct itself.

## Skills in code

```ts
import { createAgent, defineSkill } from '@lousho/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a release engineer.',
  provider,
  skills: [
    defineSkill({
      name: 'changelog',
      description: 'How to write a changelog entry',
      content: '# Changelog entries\n\nUse the imperative mood and link the PR.',
    }),
  ],
});
```

`defineSkill({ name, description, content })` validates its input. `name` must
match `^[a-z0-9][a-z0-9-_]{0,63}$`; `description` and `content` must be
non-empty. Errors say what is wrong and how to fix it.

`AgentExecutor.execute()` takes the same `skills` option; see
[the executor API](./executor-api.md).

If you already registered a tool named `load_skill`, passing `skills` throws:
rename your tool or drop the option.

## Skills from disk

`loadSkills(dir)` reads skill files, so non-developers can edit them without
touching code. Two layouts are supported and can be mixed in one directory:

```
skills/
  changelog/SKILL.md      # <name>/SKILL.md  (Anthropic / open-harness convention)
  code-review.md          # <name>.md        (eve convention)
```

Each file starts with YAML frontmatter; the rest is the skill's content:

```markdown
---
description: How to write a changelog entry
---

# Changelog entries

Use the imperative mood and link the PR.
```

- `description` is required.
- `name` is optional and defaults to the folder name (`SKILL.md` layout) or the
  file name without `.md`.
- Folders without a `SKILL.md` are ignored.
- Skills come back sorted by name, so prompts are deterministic.
- Errors name the file and the problem: missing description, invalid YAML,
  invalid name, an unreadable directory, or two skills with the same name
  (both paths are listed).

```ts
import { createAgent, loadSkills } from '@lousho/build-ai-agent';

const agent = createAgent({
  prompt: 'You are a release engineer.',
  provider,
  skills: [...(await loadSkills('./skills'))],
});
```

## Testing skills

Use [`mockModel`](./testing.md) to assert the model sees descriptions but not
bodies until it loads one: the first request's system prompt lists the skills,
and the request after a `load_skill` call contains the body in the tool result.
