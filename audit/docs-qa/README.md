# docs-qa: internal documentation Q&A bot (RAG) + CI eval gate

**Scenario.** A platform team ships a Slack/CLI bot that answers questions about
their internal SDK from its Markdown docs, with citations. It must return a
structured `{ answer, citations: [{ file, heading }] }` so the UI can link the
sources, and it is gated in CI by a golden-question eval suite that runs offline
from recorded cassettes.

Corpus: `E:\agent-sdk\docs\**\*.md` (read-only, 64 files, ~860 KB -> 889 chunks).

## SDK features exercised

| Area | What is used |
| --- | --- |
| Embeddings / retrieval | `aiSdkEmbedder()` over `@ai-sdk/openai` `.embedding()` (LM Studio nomic-embed), `inMemoryVectorMemory()` as the vector store (the SDK has no document/RAG primitive; memory is the closest), `EmbeddingProvider` interface for a disk cache |
| Agent | `createAgent()` with a custom `OpenAIProvider` instance (baseURL), `defineTool()` `search_docs`, `output` zod schema (structured output + repair step), `hooks.preGenerate` to cap `maxTokens`/`temperature` |
| Evals | `defineEval()` trajectory API with `cases`, `t.completed/calledTool/maxSteps/check/soft/toolOrder`, `t.judge()` with a local judge model, `llmJudge()`/`parseJudgeScore()` |
| CI | `lousho eval` with `--junit`, `--json`, `--record`, `--replay`, `--drift`, `--strict`, `--judge`, `--config`; `mockModel`; `recordReplay` directly (reasoning repro) |

## Files

- `corpus.ts` heading-aware chunker (repo-relative `/` paths so nothing machine-specific reaches prompts/cassettes)
- `embedder.ts` nomic embedder via `aiSdkEmbedder` + `cachedEmbedder` (sha256 -> vector disk cache, `.cache/embeddings.json`)
- `retriever.ts` two backends: `sdk` (`inMemoryVectorMemory`, default) and `plain` (own cosine store with nomic `search_query:`/`search_document:` prefixes)
- `agent.ts` the agent + `checkCitations()` (citation enforcement the app must do itself)
- `golden.ts` 8 golden questions with expected cited files
- `index.ts` CLI; `retrieval-bench.ts` recall@k / MRR for both backends
- `evals/docs-qa.eval.ts` golden trajectory eval (real model), `evals/smoke.eval.ts` deterministic `mockModel` eval, `evals/docs-qa.judge.eval.ts` local LLM judge
- `vitest.eval.config.mts`, `vitest.judge.config.mts` own configs (needed: see FINDINGS F1)
- `repro/` minimal repros for each finding

## Run (from `audit/`)

```bash
npx tsx docs-qa/retrieval-bench.ts                 # builds the index, prints recall@1/@5, MRR
npx tsx docs-qa/index.ts "How do I connect an MCP server?"
npx tsx docs-qa/index.ts --golden                  # all 8 with a quality summary

cd docs-qa
npx lousho eval evals/smoke.eval.ts --junit reports/smoke.xml           # deterministic, no LLM
npx lousho eval --config vitest.eval.config.mts --record                # LM Studio up: writes evals/__cassettes__
DOCSQA_OFFLINE=1 npx lousho eval --config vitest.eval.config.mts --replay --junit reports/evals.xml
npx lousho eval --config vitest.eval.config.mts --drift --strict        # nightly
npx lousho eval --judge --config vitest.judge.config.mts                # local judge
```

`DOCSQA_OFFLINE=1` makes the embedder cache-only, which proves the replay run
makes no embedding HTTP calls (`lousho eval --replay` itself only replays model calls).
Env: `DOCSQA_RETRIEVER=sdk|plain`, `DOCSQA_CASES=n`, `DOCSQA_MAX_TOKENS`.
