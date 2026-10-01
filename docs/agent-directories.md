# Agent directories

An agent can be defined as a directory. `loadAgentDir()` reads it and calls
`createAgent()` with the options the files describe, so it returns exactly what
`createAgent()` returns. The typed code API stays the source of truth: a
directory is a different way to write the same options, and you can switch to
code at any time without a rewrite.

> **Security:** loading an agent directory **executes its code** (`agent.ts`,
> everything in `tools/`). Only load directories you trust. No sandboxing is
> implied; the files run with your process's full permissions.

```ts
import { loadAgentDir } from '@loushy/build-ai-agent';

const agent = await loadAgentDir('./my-agent');
const { text } = await agent.send('Hello!');
```

## Layout

```text
my-agent/
  agent.ts | agent.js | agent.json | agent.yaml   # optional config
  instructions.md                                  # system prompt
  tools/*.ts | *.js                                # defineTool() tools
  skills/                                          # same layouts as loadSkills()
  subagents/<name>/                                # nested agent directories
```

Only one config file may exist. Files inside `tools/` and the entries of
`skills/` and `subagents/` are read in sorted order, so loading is
deterministic.

### Config file

```ts
// agent.ts
export default {
  model: 'openai/gpt-4o-mini',
  description: 'Triages bug reports',
  maxSteps: 8,
  toolConcurrency: 2,
};
```

| Key | Maps to |
| --- | ------- |
| `name` | `createAgent({ name })` (default: the directory name) |
| `description` | not a `createAgent` option; what a parent agent reads for a sub-agent (required there) |
| `model` | `createAgent({ model })` |
| `provider` | `createAgent({ provider })` (code config files only) |
| `instructions` | `createAgent({ instructions })` (use this or `instructions.md`, not both) |
| `maxSteps` | `createAgent({ maxSteps })` |
| `toolConcurrency` | `createAgent({ toolConcurrency })` |
| `projectInstructions` | `createAgent({ projectInstructions })` |

Unknown keys are an error with a suggestion (`'modle' (did you mean 'model'?)`).

### Tools

Each file in `tools/` default-exports a `defineTool()` tool, and may also export
more tools by name (or an array of tools). Other exports are ignored, but a file
that exports no tool at all is an error, as are two tools with the same name
(both files are named in the message).

```ts no-verify
// tools/send_email.ts
import { z } from 'zod';
import { defineTool } from '@loushy/build-ai-agent';

export default defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string(), body: z.string() }),
  execute: async ({ to, body }) => ({ sent: true, to, length: body.length }),
});
```

### Skills

`skills/` accepts what `loadSkills()` accepts: `skills/<name>/SKILL.md` and
`skills/<name>.md`, each with a `description` in its frontmatter. See
[Skills](skills.md).

### Sub-agents

Every directory in `subagents/` is itself an agent directory (and can have its
own `subagents/`). It must have a `description` in its config. The parent gets a
`delegate_to_<name>` tool that runs the sub-agent with the task text and returns
its final answer. A sub-agent uses its own `model` if it sets one, otherwise it
inherits the parent's; a `provider` override passed to `loadAgentDir()` reaches
all of them.

## How it maps to `createAgent()`

| Directory | `createAgent()` option |
| --------- | ---------------------- |
| `instructions.md` | `instructions` |
| `agent.*` keys | the options in the table above |
| `tools/` | `tools: [...]` |
| `skills/` | `skills: await loadSkills('./skills')` |
| `subagents/<name>/` | one `delegate_to_<name>` entry in `tools` |

`resolveAgentDir()` returns the assembled options and a manifest, which is
handy for tests and tooling:

```ts
import { resolveAgentDir, createAgent } from '@loushy/build-ai-agent';

const { config, manifest } = await resolveAgentDir('./my-agent');
console.log(manifest.tools, manifest.skills, manifest.subagents);
const agent = createAgent({ ...config, maxSteps: 3 });
```

## Overrides

The second argument takes the same options as `createAgent()` and wins over the
files. Use it to swap the model in tests:

```ts
import { loadAgentDir } from '@loushy/build-ai-agent';
import { mockModel } from '@loushy/build-ai-agent/testing';

const agent = await loadAgentDir('./my-agent', { provider: mockModel(['Hi there.']) });
```

`tools` and `skills` overrides replace the discovered ones (they are not
merged). A `provider/model` string in a file is dropped when you override
`provider`, so the instance is used as-is.

## Moving from files to code

Call `resolveAgentDir()`, print `config`, and paste what you need into a
`createAgent()` call; or load the directory and override just the parts you want
to own in code. Tools are plain `defineTool()` values, so a tool file can be
imported from code unchanged.

## Loading TypeScript

`.ts` files are loaded with a dynamic `import()`, so the process must already
run under a TypeScript loader: `npx tsx your-script.ts` (or ts-node, bun, deno,
or Node's built-in type stripping). Without one, loading fails with an error that
says so. Compile the directory first, or use `.js`/`.mjs` tools with an
`agent.json` / `agent.yaml` config, which work everywhere. A `.js` tool using
`import` syntax needs `"type": "module"` in the nearest `package.json` (or the
`.mjs` extension).

## Run it with `loushy dev`

```bash
npx loushy dev ./my-agent
```

Serves the chat UI and `POST /chat` for the directory and reloads it when
`instructions.md`, the config file, `tools/`, `skills/` or `subagents/` change
(see [`loushy dev`](cli.md#loushy-dev) for the details). A tool file is
imported afresh on each reload, so an edit to `tools/*.ts` takes effect on the
next message. A failed reload (a syntax error, an empty `instructions.md`) is
logged and shown in the chat page, and the previous agent keeps answering.

## What is not covered

`loushy mcp` still takes an agent spec file ([Configuration](configuration.md)),
not a directory.
