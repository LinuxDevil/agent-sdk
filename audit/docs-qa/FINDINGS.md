# docs-qa: findings

This is a RAG bot over `docs/**/*.md`. It uses 889 heading-scoped chunks with
nomic embeddings, indexed through `aiSdkEmbedder()` and
`inMemoryVectorMemory()`.

It ships with a CI eval gate covering three things:

- golden trajectories over 8 questions
- a `mockModel` smoke test
- a local LLM judge

The gate runs through `lousho eval` with `--record`, `--replay`, `--drift` and
JUnit output. Repro scripts are in `repro/`.

**Results:**

- **Retrieval:**
  - The right file was in the top 5 for 8 of 8 questions.
  - The SDK store scored an MRR of 0.875.
  - A plain store that adds nomic's query and document prefixes scored 0.938.
- **End to end:** 2 of 8 questions passed.
  - 3 runs hit the step limit while repeating searches.
  - 3 runs echoed the JSON Schema back.
  - 1 run answered in prose and had no repair step left.
- **Citations:** every citation returned matched a search result.
- **Replay:** 0.35 s, identical verdicts, offline.
- **Cassettes:** free of secrets and absolute paths.
- **Exit codes:** 0, 1 and 2 behave correctly.
- **JUnit:** the XML is valid.

### F1: `lousho eval` keeps vitest's 5 s test timeout
- **Severity:** high
- **Type:** bug / DX
- **Evidence:** every `--record`, `--drift` or live case times out.
  `defineEval` has no `timeout` option. The "record it with" hint leaves out
  the `--config` it needs.
- **Root cause:** `src/cli/eval.ts:155-166`.
- **Fix:**
  - Default `testTimeout` to something long (or none) under `--record` and live
    runs.
  - Add `defineEval({ timeoutMs })` and `lousho eval --timeout`.
  - Include `--config` in the hint.

### F2: The JUnit and JSON reports are empty when vitest itself fails
- **Severity:** high
- **Type:** bug
- **Evidence:** after a timeout or a load error, the report reads
  `tests="0" failures="0"` while the exit code is 1. CI dashboards show the run
  as green.
- **Root cause:** `src/cli/eval.ts:259-270`.
- **Fix:** write an `<error>` testcase for each file that failed to run or
  timed out.

### F3: Case labels are truncated to 45 characters, so two cases can share one cassette
- **Severity:** medium
- **Type:** bug
- **Evidence:** `--record` silently overwrites the first case's cassette, and
  `--replay` then fails.
- **Root cause:** `src/evals/defineEval.ts:115` and `src/evals/cassettes.ts:48-55`.
- **Fix:**
  - Add a short hash of the full label to the slug.
  - Detect collisions at record time.

### F4: `recordReplay` drops reasoning
- **Severity:** medium
- **Type:** bug
- **Evidence:** live, the run produced 1 reasoning block and
  `reasoningTokens: 336`. On replay there are no reasoning blocks, and the
  reasoning and cached token counts are missing.
- **Root cause:** `src/testing/recordReplay.ts:153-156` and `:282-291`.
- **Fix:** record and restore `reasoning` and the full `usage`.

### F5: Replay only covers model calls
- **Severity:** medium
- **Type:** enhancement / docs
- **Evidence:** tools still run live, so embedding calls hit the network.
  Changing the corpus breaks replay with a confusing tool-message mismatch.
- **Fix:**
  - Add a `recordReplayEmbedder()` wrapper.
  - Document that tools run live during replay.

### F6: `--drift` ignores the final answer and the structured object
- **Severity:** medium
- **Type:** enhancement
- **Evidence:** when only the citations change, `--drift` reports "Drift: none".
- **Root cause:** `src/evals/drift.ts:26,63-72`.
- **Fix:** diff `result.object` and the text (normalized) as an extra drift
  dimension.

### F7: Changing tool order breaks replay, and the error points at the wrong field
- **Severity:** low
- **Type:** DX
- **Evidence:** the error message points at `tools[0].description`.
- **Root cause:** `src/testing/fingerprint.ts:273`.
- **Fix:**
  - Sort tools by name before fingerprinting.
  - Or report "tool order changed".

### F8: No retrieval primitive, and vector memory is a weak document store
- **Severity:** medium
- **Type:** enhancement / perf
- **Evidence:**
  - Each `add()` makes one embedding call: 64 adds took 2,233 ms and 64 calls,
    compared with 1,199 ms and 1 call when batched.
  - There is no `addMany`, no upsert by id, no metadata filter and no chunker.
  - `EmbeddingProvider` cannot tell queries from documents.
- **Proposed API:**
  - `createDocIndex({ embedder })` with `.upsert(docs)` and `.search(q, { k, filter })`
  - `retrievalTool(index)`
  - `chunkMarkdown(text)`
  - `embed(texts, { inputType: 'query' | 'document' })`

### F9: Output validation can't see tool results, and the repair can't handle a schema echo
- **Severity:** medium
- **Type:** enhancement
- **Evidence:**
  - Citation grounding can't trigger the repair step.
  - When the model echoes the JSON Schema, the repair message only says
    "fields required", and the model repeats the same output.
- **Fix:**
  - Render the format as a filled example.
  - Detect a schema echo explicitly.
  - Add `output.validate(obj, { toolResults })`.

### F10: No per-tool call cap and no forced final answer
- **Severity:** medium
- **Type:** enhancement
- **Evidence:** 3 of 8 cases failed with max-steps after repeating searches.
  This is also log-incident F21.
- **Fix:**
  - Add `maxCallsPerRun` to tools.
  - Add a tools-disabled final step.

### F11: LM Studio context overflow is treated as `unknown` and retryable
- **Severity:** low
- **Type:** bug
- **Evidence:** a deliberate 45k-token prompt cost 3 HTTP requests.
- **Root cause:** `src/execution/errors.ts:322` and
  `src/providers/aiSdkProvider.ts:352`. This is `_cross` X1.

### F12: The judge only sees the reply, and its score parser is fragile
- **Severity:** low
- **Type:** enhancement / bug
- **Evidence:**
  - `t.judge()` gets no question and no retrieved context.
  - `judge.model` is required even when the provider has a default.
  - `"Score: 0.9"` and `"**0.9**"` parse as 0.
  - `"9/10"` parses as 1, but only because the value is clamped.
- **Root cause:** `src/evals/llmJudge.ts:111,177`.
- **Fix:**
  - Pass `{ input, context }` to the judge.
  - Use a robust score regex.
  - Default to the provider's model.

### F13: `t.result.object` is `any` inside `defineEval`
- **Severity:** low
- **Type:** typing
- **Root cause:** `src/evals/trajectory.ts:56,60`.

### F14: Cassettes and reports are noisy
- **Severity:** low
- **Type:** DX
- **Evidence:**
  - `recordedAt` changes on every re-record, so cassettes always show up in
    git diffs.
  - Replay errors print two conflicting re-record hints, and `lousho eval`
    ignores one of them (`LOUSHO_RECORD=1`).
  - Reports contain absolute paths.
  - Cassettes say `provider: "openai"` for an LM Studio base URL.
