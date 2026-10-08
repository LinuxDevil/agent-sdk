# coding-agent (local LM Studio harness) — run log

Harness: `local-harness.ts` (index.ts in this folder belongs to a separate OpenRouter harness).
Model: qwen3.5-9b via LM Studio. Raw outputs: `.runs/run*.txt`, `.runs/kit-model.txt`.

## Runs 1-7 (LM Studio loaded at 8192 total ctx, ~2K per parallel slot)

All died with `CompactedLLMProviderError: ... {"code":500,"message":"Context size has been exceeded."}`
at steps 1-9 — an environment problem (coordinator confirmed), not an SDK bug. They did show:
- default `retry` never retried it (classified `unknown`, F8); with a custom `retryOn`, `provider.retry` fired
  but only for failures before the first streamed chunk (F9);
- `run.done` of the failed continuation carried no usage (F10);
- compaction never fired although provider-reported prompts (3055) exceeded the threshold (2457) — the
  estimate counts messages only (F19).

## Run 8 — success (LOCAL_CTX=8192 MAX_OUT=2048 STREAM_CALLS=1, after LM Studio reload with 32K/4 slots)

```
-- step 1  tool.start list_dir {"path":""}                      usage=1448/27
-- step 4  read_file x3 (index.js, parseDuration.js, slugify.js) usage=1685/24
-- step 7  tool.start shell {"command":"node --test"}  -> approval.requested
== run.done awaiting-approval usage={"promptTokens":13484,...,"modelCalls":7}
   >> policy APPROVED "node --test"
-- step 8  edit_file src/parseDuration.js "  m: 60 * 100," -> "  m: 60 * 1000,"
-- step 9  edit_file src/slugify.js (adds .toLowerCase(), [^a-z0-9]+)
-- step 10 shell node --test -> approval -> APPROVED
-- step 11 edit_file src/parseDuration.js regex -> /^(\d+(?:\.\d+)?)(ms|s|m|h)$/
-- step 12 shell node --test -> approval -> APPROVED
-- step 13 text: All tests now pass. Here's a summary of the fixes: ...
== run.done stop usage={"promptTokens":37320,"completionTokens":938,"totalTokens":38258,"modelCalls":13}
last finishReason=stop steps=13 approvalsDecided=3 wall=1146s
usage: {..."modelCalls":13,"cachedInputTokens":29565,"reasoningTokens":761}
event counts: {"run.start":4,"step.start":13,"tool.start":15,"permission.decision":15,"tool.done":15,"step.done":13,
               "approval.requested":3,"run.done":4,"tool.resume":3,"text.delta":177,"text.done":1}
tests untouched: true
checkpoints: [{"turn":0,"paths":["src/parseDuration.js","src/slugify.js"]}]
independent verification: node --test exit=0  tests 7, pass 7, fail 0
```
All three bugs fixed; test files byte-identical; usage after resumes is cumulative (37,320 prompt tokens over
13 calls). No `reasoning.*` events although 761 reasoning tokens were reported (F20).

## coding-kit via `lousho add` + `loadAgentDir` + real model (`bash repro/kit.sh --model`)

```
lousho add (default registry): LOUSHO_REGISTRY_UNREACHABLE (registry.lousho.com NXDOMAIN)
lousho add --registry <repo>/registry/dist/index.json: Added coding-kit: 11 file(s)
[lousho] loadAgentDir: registry item 'coding-kit' no longer matches its install receipt (approve.ts was modified) ...
  tool.start shell {"command":"node --test"}
  DENY shell You already called shell with these arguments 2 times. hook=loop-guard      <- first call of THIS agent
  ... reads files, then edit_file src/parseDuration.js -> approval.requested (stream() ignores approve.ts)
  run.done awaiting-approval
after: node --test exit 1 (pass 2, fail 5)
```
The very first `node --test` of the real-model agent was denied because an earlier agent loaded in the same
process (the probe) had used up the kit's module-global loop guard (F5); the approve.ts edit by the probe (F4)
made the receipt unattested.
