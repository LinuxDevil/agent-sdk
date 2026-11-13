# workspace-marketing

One Marketing workspace with two pages, `instagram-videos` and `facebook-videos`. Both attach the same three agents (`script-maker`, `video-maker`, `voice-maker`) from `workspace/agents/`; nothing is copied per page. What differs is each page's harness: its platform and audience profiles, its task text and its output contract. Both pages use `execution.type: single`.

The workspace is loaded into `memorySource` and run through `createWorkspaceRuntime(source, host)`. The host (`host.ts`) injects everything environmental: the tools, the policy ceiling, the provider, the stores and the checks.

| Piece | Where |
|---|---|
| Workspace files | `workspace/` |
| Host: tools, stores, checks, scripted model | `host.ts` |
| CLI | `run.ts` |
| Tests | `index.test.ts` |

The `render_video` and `synthesize_voice` tools are mocks. They write small placeholder artifacts (`video`, `voice`) into the current run's artifact store. `workspace/` is a deliberate fork of the P0.11 Marketing fixture (`src/workspaces/__fixtures__/marketing`), trimmed to two `single` pages; it does not track the fixture.

`script-maker` owns `render_video` and `synthesize_voice` because the `single` engine runs only the page's one agent. When P3 switches Instagram to a workflow and Facebook to multi-agent, the script attachment narrows its tools with `tools.only` and the video and voice agents take over.

The policy requires a sandbox, so the host's `bindTool` refuses any tool that is not one of the three in-process mocks, and refuses a mock that was granted secrets. A real host binds tools to a real sandbox and to their scoped secrets instead.

The `.ts` files under `workspace/` only name the host tools and checks and are never imported.

## Run it

```bash
npx tsx examples/workspace-marketing/run.ts --mock
npx tsx examples/workspace-marketing/run.ts --mock --page instagram
npx tsx examples/workspace-marketing/run.ts --model openrouter/openai/gpt-4o-mini --page facebook
```

`--mock` runs offline with a scripted model. Without it, `--model` names a live model. `--page` takes `instagram`, `facebook` or a full page id and defaults to both. Artifacts are written under the temp directory the run prints.

## Test it

```bash
npx vitest run examples/workspace-marketing
```
