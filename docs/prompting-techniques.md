# Prompting and context techniques

Agent quality comes from three layers, and it is worth knowing which layer a
technique lives at, because the fix for a misbehaving agent is different at
each one:

1. **Prompt-level techniques** — what a single model call is asked to do and
   how the ask is phrased.
2. **Context engineering** — what fills the context window: what gets
   written, selected, compressed and isolated.
3. **Agentic workflow patterns** — how many calls, in what shape, with which
   gates: chains, routing, parallel workers, evaluators, waves, phases.

Lousho gives you the second and third layers as real machinery (tools,
permissions, memory, sub-agents, flows, evaluators), so prompt-level
techniques stay a thin layer of instructions on top.

## Prompt-level techniques

These all reduce to instructions and message shape — `createAgent`'s
`instructions` / `prompt`, seeded session turns, and `output` schemas.

| Technique | What it is | How to use it in Lousho |
| --------- | ---------- | ----------------------- |
| Zero-shot | Task + constraints only, no examples | The default: `instructions` |
| Few-shot (in-context learning) | Show input/output pairs so the model copies the shape | Put example pairs in `instructions`, or seed `agent.session().send()` turns — a scripted "user/assistant" exchange the real turn continues |
| Chain-of-thought | "Think step by step" before answering | Instructions. Prefer `reasoning` effort where the provider supports it — reasoning tokens are cleaner than prompted monologue |
| Self-consistency | Sample N answers, take the majority | N runs + a vote step (a flow `parallel`/`llmCall` fan-out, or a sub-agent per sample) |
| Tree/graph-of-thoughts | Explore a branching search of reasoning paths | A sub-agent per branch, an aggregator comparing them — same fan-out shape as [deep-research](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/deep-research) |
| ReAct | Interleave reasoning and acting | The agent loop itself: every Lousho tool loop is ReAct |
| Reflexion | Critique the last attempt, retry with the critique | [evaluator-loop](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/evaluator-loop): `llmCritique` feedback carried into the next draft |
| Least-to-most | Solve the easy sub-problem first, chain to harder ones | Instructions decomposing into ordered steps, or a `flows` sequence |
| Plan-and-solve / plan-and-execute | Write a plan, then execute it | `permissionMode: 'plan'` — the agent must produce a plan before any write tool runs; see [plan-mode](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/plan-mode) |
| Skeleton-of-thought | Outline first, expand each point (in parallel) | A `task` fan-out over outline points — the deep-research shape |
| Self-ask | The model asks and answers its own follow-ups | Instructions, or an explicit `oneOf` flow that loops a clarifying sub-agent |
| Generated knowledge | Ask the model to state relevant facts, then answer | A first `llmCall` into a variable, the second prompt templated with it |
| Meta-prompting | A model writes the prompt another call uses | One `llmCall` emitting the next step's prompt text into a variable |
| Persona / role | "You are a …" framing | `instructions` — keep it to scope and tone; personas don't add knowledge |
| Negative / constrained prompting | "Never do X", output restrictions | Instructions for style; enforcement belongs in [guardrails](./guardrails.md) and permission rules, not the prompt |
| Delimiters & instruction hierarchy | Mark untrusted data vs. instructions | Quote tool results/data in instructions; permission rules and `principal` are the real trust boundary — a hostile tool result can't overwrite a `deny` rule |
| Scratchpad | Give the model a place to write working notes | A memory slot (`remember_*`/`recall_*` tools), or a file in the workspace tools' dir, or `.claude/scratchpad/` via `claudeProject()` |
| Structured / constrained output | The answer must match a schema | `createAgent({ output: schema })` — validated, typed, retried on parse failure. See [Structured output](./structured-output.md) |

Two rules of thumb:

- Instructions steer; machinery enforces. Anything that must *never* happen
  (no deletes, no prod writes) goes in `permissions`, guardrails and tools —
  not the prompt.
- Techniques that spend more tokens (self-consistency, trees, critiques) pay
  off where a wrong answer is expensive; watch `result.usage` / `limits` and
  budget them like any other spend.

## Context engineering

The four operations, and where each lives in the SDK:

| Operation | What it means | Lousho surface |
| --------- | ------------- | -------------- |
| **Write** | Persist information outside the transcript so a later turn/run can reload it | Memory slots (`defineMemory` → `remember_*`/`recall_*` tools, scoped per user/sender/run), checkpoint + session stores, `store: { dir }` in agent dirs |
| **Select** | Load only what's relevant right now | Skills (`load_skill` progressive disclosure), `toolSearch`/`deferLoading` (tools found on demand), memory scopes |
| **Compress** | Shrink what's already there | `compaction` (summarize old turns), tool-result truncation, `inputFilter` on handoffs |
| **Isolate** | Run work in a clean context so detail doesn't flood the lead | Sub-agents (`task` calls see only their prompt), code mode (`run_code` returns one value), the `inputFilter` boundary |

```ts no-run
import { createAgent, loadSkills } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const provider = mockModel([{ text: 'done' }]);
const researchAgent = createAgent({ provider, instructions: 'You research one slice.' });

const agent = createAgent({
  provider,
  instructions: 'You triage inbound email.',
  skills: await loadSkills('./skills'),             // select: bodies load on demand
  toolSearch: { thresholdPercent: 0.1 },            // select: big tool surface stays deferred
  compaction: { summarizer: 'openai/gpt-4o-mini' }, // compress: old turns fold into a summary
  subagents: { researcher: researchAgent },         // isolate: task runs in a clean context
});
```

The practical ordering: write durable facts to memory, select skills and
tools on demand, compress the transcript when it grows, isolate anything
token-hungry (search result dumps, file reads, subprocess output) behind a
sub-agent or a tool that returns a digest.

## Agentic workflow patterns

The canonical shapes (Anthropic's "building effective agents" taxonomy) and
the community terms that named two of them — all runnable in the repo:

| Pattern | Shape | Lousho example |
| ------- | ----- | -------------- |
| Prompt chaining | Step → step → step, each a call | `flows` sequences (`llmCall` → `llmCall`) |
| Routing | Classify, then dispatch to a specialist | [workflow-router](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/workflow-router); durable version: [support-desk](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/support-desk) handoffs |
| Parallelization | N calls at once, results merged | Parallel `task` calls (`toolConcurrency` is unbounded by default) |
| Orchestrator-workers | A lead decomposes work, workers execute | [deep-research](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/deep-research) |
| Evaluator-optimizer | Draft → score → revise loop | [evaluator-loop](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/evaluator-loop) (`llmCritique`) |
| **Wave engineering** | Bounded waves of parallel workers with a verify gate and scoped extension (WAVES: Workers · Aggregate · Verify · Extend) | [waves](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/waves) |
| **Phase engineering** | Deterministic phase pipelines — spec → plan → implement → verify — the model can't skip, with proof-command gates | [phase-pipeline](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/phase-pipeline) (flows + real proof steps) |
| Autonomous loop | Open-ended tool loop until done | The default agent loop, bounded by `maxSteps`, `limits`, permissions |
| Handoffs | Control transfers wholesale to a specialist | [support-desk](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/support-desk), [handoffs](./handoffs.md) |

### Typed decisions ("System One" style)

Some steps shouldn't generate text at all — they should *decide*: classify,
route, score, verify. The pattern (TypeSafe's Jev makes a whole model of it)
is a typed probabilistic decision: unstructured state in, `{ action,
confidence }` out, and the workflow branches on it. In Lousho that's an
agent with an `output` schema feeding a flow's `oneOf` — and a confidence
floor that routes low-confidence calls to a human instead of acting on a
guess:

```ts no-verify
const triage = createAgent({
  provider,
  output: z.object({
    action: z.enum(['patch', 'ask-human', 'wontfix']),
    confidence: z.number(),
    reason: z.string(),
  }),
});
// in the flow: oneOf on result.object.action,
// and confidence < 0.7 routes to a human queue rather than acting.
```

[coding-agent-workflows](https://github.com/LinuxDevil/agent-sdk/tree/main/examples/coding-agent-workflows)
is the full example: a coding agent driven by a deterministic workflow whose
branch points are typed decisions, where confidence below the floor exits
`needs-human` instead of patching.

## Where to go next

- [Structured output](./structured-output.md), [evals](./evals.md)
  (`llmJudge`, `llmCritique`) for the decide/score primitives
- [Flows](./flows.md) for deterministic pipelines and phase gating
- [Sub-agents](./sub-agents.md) and [handoffs](./handoffs.md) for parallel
  and transfer patterns
- [Memory](./memory.md), [compaction](./compaction.md), [skills](./skills.md),
  [tool search](./tool-search.md) for the context layer
- [Approvals](./approvals.md) and [guardrails](./guardrails.md) for the gates
  that keep bounded autonomy safe
