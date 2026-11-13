# workspace-marketing

One Marketing workspace with two pages, `instagram-videos` and `facebook-videos`. Both attach the same three agents (`script-maker`, `video-maker`, `voice-maker`) from `workspace/agents/`; nothing is copied per page. What differs is each page's harness: its platform and audience profiles, its task text and its output contract. Both pages use `execution.type: single`.

The workspace is loaded into `memorySource` and run through `createWorkspaceRuntime(source, host)`. The host (`host.ts`) injects everything environmental: the tools, the policy ceiling, the provider, the stores and the checks.

| Piece | Where |
|---|---|
| Workspace files | `workspace/` |
| Host: tools, stores, checks, scripted model | `host.ts` |
| CLI | `run.ts` |
| Tests | `index.test.ts` |

The `render_video` and `synthesize_voice` tools are mocks. They write small placeholder artifacts (`video`, `voice`) into the current run's artifact store. The `.ts` files under `workspace/` only name the host tools and checks and are never imported.

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
