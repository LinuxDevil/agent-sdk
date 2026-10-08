# RUN_LOG — research-analyst live runs

Two full live runs against `openrouter/openai/gpt-4o-mini` (OpenRouter,
`OPENROUTER_API_KEY` from repo-root `.env`). Both passed all 7 audit checks.
Total spend per run ≈ $0.005 (17–19 model calls, ~40 s wall).

## Run 1 — `npx tsx research-analyst/index.ts`

```
question: What breaks first when a Node.js app is under memory pressure?
model: openrouter/openai/gpt-4o-mini  ·  maxWaves: 2  ·  traces: …/traces

--- wave 1: 3 task result(s), sameTurn=true ---
  [V8 heap/GC behavior] Investigate how V8 heap and garbage collection behavior is affected…
  [event-loop impact] Examine the impact of memory pressure on the Node.js event loop…
  [external/native memory and OOM] Analyze the behavior of external/native memory…
verdict: pass=false gaps=["OS/container OOM kills","diagnostics (heap snapshots, tooling)","mitigations/backpressure"]

--- wave 2: 3 task result(s), sameTurn=true ---
  [OS/container OOM kills] …
  [diagnostics (heap snapshots, tooling)] …
  [mitigations/backpressure] …
verdict: pass=false gaps=["OS/container OOM kills","diagnostics (heap snapshots, tooling)"]   # cap reached

[PASS] waves/sub-agent fan-out :: 6 task call(s) over 2 wave(s); 6 briefs; all issued same-turn=true
[PASS] parallel execution (trace overlap) :: overlapping researcher span pairs=6; knowledge_search maxConcurrent=1
[PASS] clean-context isolation :: coordinator canary absent from sub-agent briefs
[PASS] verify + extend :: waves=2/2 final pass=false gaps=2
[PASS] structured output report :: title="Memory Pressure Effects in Node.js Applications" sections=4 citations=5 confidence=0.95 allIdsInCorpus=true allIdsServed=true

per-run usage:
  wave-1-coordinator     5,945 in / 1,397 out tokens · $0.0017 (8 model calls) steps=2 finish=stop delegated{runs=3,calls=6,in=3097,out=1070,cost=$0.0011}
  wave-1-verifier        1,302 in / 30 out tokens · $0.0002 (1 model call)    steps=1 finish=stop
  wave-2-coordinator     6,662 in / 1,684 out tokens · $0.0020 (8 model calls) steps=2 finish=stop delegated{runs=3,calls=6,in=3613,out=1262,cost=$0.0013}
  wave-2-verifier        2,474 in / 24 out tokens · $0.0004 (1 model call)    steps=1 finish=stop
  report-writer          2,748 in / 511 out tokens · $0.0007 (1 model call)   steps=1 finish=stop
[PASS] usage + cost accounting :: total 19131in/3646out across 19 model calls; sum(costUsd)=$0.005057 vs estimateCost=$0.005057; byModel sums match=true
[PASS] observability (fileTraceExporter + withSpan) :: 8 trace file(s); 6 nested invoke_agent researcher spans; withSpan phase spans emitted
[PASS] llmJudge eval (stretch) :: score=1
```

## Run 2 — identical command, different draw

Verifier found 2 gaps (not 3), so wave 2 fanned out 2 tasks — the pipeline
sizes itself to the verdict. All checks passed again:

```
--- wave 1: 3 task result(s), sameTurn=true ---
verdict: pass=false gaps=["diagnostics (heap snapshots, tooling)","mitigations/backpressure"]
--- wave 2: 2 task result(s), sameTurn=true ---
verdict: pass=false gaps=["Diagnostics …","Mitigations/backpressure …"]  # strict judge, cap hit

[PASS] waves/sub-agent fan-out :: 5 task call(s) over 2 wave(s); 5 briefs; all issued same-turn=true
[PASS] parallel execution (trace overlap) :: overlapping researcher span pairs=4
[PASS] clean-context isolation :: canary absent
[PASS] verify + extend :: waves=2/2 final pass=false gaps=2
[PASS] structured output report :: title="Memory Pressure in Node.js Applications: Breakpoints and Effects" sections=5 citations=6 confidence=0.95 allIdsServed=true
  wave-1-coordinator     7,006 in / 1,556 out tokens · $0.0020 (8 model calls) delegated{runs=3,calls=6,cost=$0.0013}
  wave-2-coordinator     4,768 in / 1,083 out tokens · $0.0014 (6 model calls) delegated{runs=2,calls=4,cost=$0.0008}
[PASS] usage + cost accounting :: 17735in/3329out across 17 calls; sum(costUsd)=$0.004658 vs estimateCost=$0.004658
[PASS] observability :: 8 trace file(s); 5 nested invoke_agent researcher spans
[PASS] llmJudge eval :: score=1
```

## Repros

```
$ npx tsx research-analyst/repro/judge-guard.ts
[PASS] judge-guard :: SDKError code=LOUSHO_EVALS_INVALID :: llmJudge() was invoked outside the judge-eval runner…

$ npx tsx research-analyst/repro/subagent-no-description.ts
[PASS] no-description :: code=LOUSHO_CONFIG_INVALID :: createAgent: sub-agent 'silent' has no description…

$ npx tsx research-analyst/repro/abort-fanout.ts
[PASS] abort mid-fan-out resolves, not rejects :: finishReason=aborted steps=1 680 in / 158 out tokens · $0.0002 delegated={"runs":2,"modelCalls":0,"totalTokens":0}
[PASS] delegated usage kept for killed children :: runs=2 modelCalls=0 tokens=0

$ npx tsx research-analyst/repro/task-resume.ts
[PASS] turn 1 produced a taskId :: taskId=task_1
[PASS] task resume by taskId keeps context :: task calls=1 answer has C# id=true answer="C3  [sub-agent 'researcher': 1 step(s), finish reason 'stop', taskId 'task_1']"
```
