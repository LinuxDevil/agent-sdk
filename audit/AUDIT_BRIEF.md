# Lousho SDK real-world audit — shared brief

Goal: build six real-world consumer projects on the **packed** SDK
(`@lousho/build-ai-agent@1.0.0-alpha.18`, installed from the tarball in
`audit/node_modules`), run them against a **local LM Studio model**, and record
real bugs, DX problems, doc gaps and enhancements in the SDK.

## Environment

- Workspace: `E:\agent-sdk\audit` (shared `package.json`, `node_modules`, `tsx`).
  Each project lives in its own folder: `audit/<project>/`.
- Stack: `ai@7`, `@ai-sdk/openai@4`, `zod@4`, `@modelcontextprotocol/sdk`. Add other deps
  with `npm install` in `audit/` only if a project truly needs them.
- Model: LM Studio OpenAI-compatible server at `http://localhost:1234/v1`,
  model id `qwen3.5-9b-uncensored-hauhaucs-aggressive` (9B reasoning model, ~6 s per call,
  emits reasoning tokens). Embeddings: `text-embedding-nomic-embed-text-v1.5`
  at `http://localhost:1234/v1/embeddings`.
  Other agents share this server, so calls may queue — keep runs small.
- Known-good connection (verified):
  ```ts
  import { createAgent, OpenAIProvider } from '@lousho/build-ai-agent';
  const provider = new OpenAIProvider({ apiKey: 'lm-studio', baseURL: 'http://localhost:1234/v1', defaultModel: 'qwen3.5-9b-uncensored-hauhaucs-aggressive' });
  ```
  `model: 'openai/<id>'` + `OPENAI_BASE_URL` env also works. Put a shared helper in
  `audit/_shared/local.ts` if it doesn't exist (check first; another agent may have made it).
- SDK source is at `E:\agent-sdk\src` and docs at `E:\agent-sdk\docs` — read them to
  learn the API and to cite root causes. **Do NOT modify anything outside `audit/`.**
  Import only from `@lousho/build-ai-agent` (and its subpaths) — never from `../../src`.

## What each project must contain

1. `README.md` — the real-world scenario, what SDK features it exercises, how to run.
2. Runnable code (`index.ts` + whatever else). It must actually run end to end against
   the local model. Run it, several times if behavior is flaky. Save representative run
   output to `audit/<project>/RUN_LOG.md` (trim noise).
3. `FINDINGS.md` — the audit. One entry per finding:
   - `### F<n>: <title>` then **Severity** (critical/high/medium/low), **Type**
     (bug / DX / docs / enhancement / perf / security), **Evidence** (observed output or a
     minimal repro you actually ran — put repro scripts in `audit/<project>/repro/`),
     **Root cause** with `src/...:line` citations when it is an SDK issue, and
     **Suggested fix**.
   - Only report what you verified. Distinguish SDK bugs from small-model weakness
     (a 9B model fumbling a tool call is not an SDK bug — but how the SDK *handles* that
     fumble, e.g. error messages, repair, retries, is in scope).
   - Aim for depth: exercise edge cases (aborts, invalid tool args, schema failures,
     resume after crash, concurrency, Windows paths, streaming event shapes, typings).
   - Also check the TypeScript experience: run `npx tsc --noEmit -p .` style checks on your
     project (a `tsconfig.json` exists at `audit/`) and report typing problems. Known cross-cutting issue (already logged, do not re-report): the shipped .d.ts files use zod 3 types and fail under zod 4 without skipLibCheck; tsconfig has skipLibCheck: true for that reason.

## Rules

- Never print, log, or commit secrets. Never call anything that mutates real
  infrastructure, sends messages, or spends money.
- Keep total wall time reasonable (aim < 60 min). Final reply: a terse summary of the
  project and the list of finding titles with severities.
