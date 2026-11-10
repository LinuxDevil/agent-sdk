# Good first issues

A working list of small, real tasks for new contributors. Each one is a
ready-to-paste issue body. Open it with the `good first issue` label, then
remove it from this list.

Every gap below was checked against `main` on 9 Nov 2026.

---

## 1. Add a README to `examples/tracing`

**Context**

Every directory under `examples/` has a `README.md` except
`examples/tracing`. It holds four files:

- `examples/tracing/weather-scenario.ts`: a weather agent on a scripted mock
  provider, shared by both runners.
- `examples/tracing/console-exporter.ts`: a minimal `TraceExporter` that logs
  spans to the console.
- `examples/tracing/run-console.ts`: runs the scenario with the console
  exporter (`npm run example:tracing:console`).
- `examples/tracing/run-otel.ts`: runs it with `createOtelTraceExporter()` and
  the OpenTelemetry console exporters (`npm run example:tracing:otel`).

`examples/README.md` lists the example, but a reader who opens the directory
on GitHub sees no explanation. `scripts/generate-llms-txt.ts` also skips
examples without a README, so this one is missing from `llms-full.txt`.

**What to do**

- Add `examples/tracing/README.md`. Follow the shape of a short one, such as
  `examples/workflow-router/README.md`: a one-paragraph summary, then how to
  run each script.
- Say that both scripts run offline, with no API key.
- Link to `docs/observability.md` for the full tracing guide.
- Run `npm run docs:llms` and commit the updated `llms.txt` and
  `llms-full.txt`.

**Acceptance criteria**

- `examples/tracing/README.md` exists and names both npm scripts.
- `npm run docs:llms:check` passes.
- `npm test` passes (`examples/README.test.ts` is unchanged).

---

## 2. Bring the `lousho --help` command list in line with the real subcommands

**Context**

The top-level usage text in `bin/lousho.js` (the `USAGE` array) has drifted
from the commands it describes:

- `lousho observe <start|status|stop|rebuild-rollups|token>` is missing
  `prune`, `export`, `failures` and `score`. All four exist in
  `src/cli/observe.ts` (see `ObserveSubcommand`).
- `lousho prompt <push|list|get>` is missing `label`, which exists in
  `src/cli/prompt.ts` (see `PromptSubcommand`).
- The `add` line says it installs "a tool, skill, channel, schedule or kit".
  The registry also has `memory` items (`itemType` in `src/cli/registry.ts`).

**What to do**

- Update those three entries in `USAGE` in `bin/lousho.js`. Keep each line's
  current style.
- Add assertions for the new text to the "keeps the top-level usage in step
  with the commands" test in `src/cli/bin.test.ts`.

**Acceptance criteria**

- `npx lousho --help` lists every `observe` and `prompt` subcommand, and the
  `add` description names memory slots.
- `npm test -- src/cli/bin.test.ts` passes.
- No other command's output changes.

---

## 3. Complete the command table in `docs/cli.md`

**Context**

The table at the top of `docs/cli.md` is the first thing most readers see.
It has gaps:

- There is no row for `lousho observe` or `lousho prompt`. Both have their own
  sections further down the page (`## lousho observe`, `## lousho prompt`).
- The `lousho add` row says "tool, skill, channel, schedule or memory slot".
  It leaves out `kit`, which `docs/registry.md` describes.
- The `lousho observe` line in the `## Usage` block lists
  `<start|status|stop|rebuild-rollups|prune|export|failures|token>` but not
  `score`. `score` is documented in the same file
  (`npx lousho observe score --agent support`) and in
  `docs/observability.md`.

**What to do**

- Add a row for `lousho observe` and one for `lousho prompt`. Link each to its
  section on the same page (`#lousho-observe`, `#lousho-prompt`).
- Add "or kit" to the `lousho add` row.
- Add `score` to the `observe` line in the Usage block.
- Keep the house style: short sentences, plain words.

**Acceptance criteria**

- The table has one row per command in `bin/lousho.js` (`COMMANDS`).
- `npm run docs:llms` is run and the updated `llms.txt` and `llms-full.txt`
  are committed. `npm run docs:llms:check` passes.
- `npm test -- scripts/docs-links.test.ts` passes.

---

## 4. Link the connectors and Claude Code projects pages from related docs

**Context**

Two docs pages have no inbound link from any other page in `docs/` or from
`README.md`:

- `docs/connectors.md`: how to reach Google Docs, Slack, GitHub and similar
  services through MCP servers.
- `docs/claude-projects.md`: how `claudeProject()` loads `CLAUDE.md`,
  `.claude/skills/` and `.claude/agents/` into `createAgent()`.

A reader browsing the repo, or a coding agent reading `node_modules/lousho/docs`,
can only find them by luck.

**What to do**

- In `docs/mcp.md`, add a sentence that points to `./connectors.md` for
  ready-made service connectors.
- In `docs/skills.md` or `docs/agent-directories.md`, add a sentence that points
  to `./claude-projects.md` for repositories that already use Claude Code's
  file layout.
- Run `npm run docs:llms` and commit the updated `llms.txt` and
  `llms-full.txt`.

**Acceptance criteria**

- `grep -l "connectors.md" docs/*.md` and `grep -l "claude-projects.md" docs/*.md`
  each return at least one page other than the page itself.
- `npm test -- scripts/docs-links.test.ts` passes.
- `npm run docs:llms:check` passes.

---

## 5. Add an offline test for `examples/workflow-router`

**Context**

Most examples have an `index.test.ts` that runs them offline with a scripted
model, for example `examples/waves/index.test.ts`. `examples/workflow-router`
has none. Its `index.ts` builds the agent at module scope and calls `main()`
on import, so a test cannot import it without running the demo.

**What to do**

- In `examples/workflow-router/index.ts`, export a small function, such as
  `routeRequest(provider, message)`, that builds the agent and returns the
  route.
- Only call `main()` when the file is run directly. Copy the guard at the end
  of `examples/waves/index.ts`.
- Add `examples/workflow-router/index.test.ts`. Use `mockModel` from
  `lousho/testing` to script the model's reply, and check that the function
  returns it. See `docs/testing.md`.
- Keep `npm run example:workflow-router` working with no API key.

**Acceptance criteria**

- `npm test -- examples/workflow-router` passes with no network and no API key.
- `npm run typecheck:examples` passes.
- `npm run example:workflow-router` prints the same output as before.

---

## 6. Add an `example:coding-harness` npm script

**Context**

`package.json` has an `example:<name>` script for most examples
(`example:waves`, `example:support-desk`, `example:deep-research` and so on).
`examples/coding-harness` has none, even though its README runs it offline
with `npx tsx examples/coding-harness/index.ts`.

**What to do**

- Add `"example:coding-harness": "tsx examples/coding-harness/index.ts"` to
  `scripts` in `package.json`, next to the other `example:` scripts.
- In `examples/coding-harness/README.md`, show `npm run example:coding-harness`
  as the offline command. Keep the live `OPENROUTER_API_KEY=...` line.
- Run `npm run docs:llms` and commit the updated `llms-full.txt`.

**Acceptance criteria**

- `npm run example:coding-harness` runs the offline demo with no API key.
- `npm run docs:llms:check` passes.

---

## 7. Replace the old "Build AI Agent SDK" name

**Context**

The project is called Lousho, but two files still use an old working name:

- `CONTRIBUTING.md`, line 3: "Thank you for your interest in contributing to
  the Build AI Agent SDK!"
- `src/index.ts`, the `@packageDocumentation` block at the top: "Build AI
  Agent SDK".

`CONTRIBUTING.md` and `src/` both ship in the npm package, so users see the
old name too.

**What to do**

- Replace the old name with "Lousho" in both places. Keep the sentences short.
- Search the rest of the repo (`git grep "Build AI Agent SDK"`) and fix any
  other hit outside `CHANGELOG.md`.

**Acceptance criteria**

- `git grep "Build AI Agent SDK" -- ':!CHANGELOG.md'` returns nothing.
- `npm run lint`, `npm run typecheck` and `npm test` pass.
