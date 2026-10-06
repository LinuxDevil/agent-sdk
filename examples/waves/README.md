# waves

**WAVE engineering** — Workers · Aggregate · Verify · Extend — the bounded-parallel pattern from the community "waves" workflows (rayfernando-skills, Wave-Engineering/claudecode-workflow). Unlike a plain task fan-out, the wave owns a *verification spine*: worker outputs are merged deterministically, a verifier judges the aggregate against a typed schema, and a follow-up wave runs **only** on the gaps the verifier names.

```text
         ┌────────────────────────── wave ──────────────────────────┐
tasks ──►│  worker(worker-1)   worker(worker-2)   worker(worker-3)  │──► outputs
         │          (bounded parallel, concurrency-sized chunks)    │
         └──────────────────────────────────────────────────────────┘
                              │ aggregate (deterministic merge)
                              ▼
                        verifier: { verdict, gaps[] }
                          │              │
                     'pass' │              │ 'extend'
                          ▼              ▼
                        result    gaps → tasks → next wave
```

## The mapping

| WAVES step | Lousho surface |
| ---------- | -------------- |
| Workers    | `Promise.all` over `agent.send()` — the harness owns the wave shape; each worker is a fresh `createAgent` so contexts stay clean |
| Aggregate  | a plain function — deterministic, so a dropped contribution is a bug, not a silent merge |
| Verify     | `createAgent({ output: VERDICT })` — the Jev-style typed-decision idiom: `{ verdict: 'pass'\|'extend', gaps: string[] }` |
| Extend     | `verdict.gaps.map(gapToTask)` seeds the next wave's task list |

Run it:

```bash
npm run example:waves            # offline, scripted workers + verifier
OPENROUTER_API_KEY=… npx tsx examples/waves/index.ts   # live
```

When to reach for it: breadth-first work where *coverage* is checkable — summarizing a corpus, auditing a codebase, migrating files — and a partial answer is worse than a slow one. When a single orchestrator can hold the whole task, [deep-research](../deep-research/)'s lead-delegates-subtasks shape is simpler.

See [docs/prompting-techniques.md](../../docs/prompting-techniques.md) for where wave engineering sits in the full pattern catalog.
