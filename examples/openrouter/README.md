# openrouter

Runnable snippets showing `OpenRouterProvider` usage: basic and streaming
generation, multi-model comparison, tool calling, `AgentBuilder` configuration,
model listing, cost-aware model choice, error handling, multi-turn conversation,
and capability checks.

Unlike the mock-backed examples, these make real calls and need an
[OpenRouter API key](https://openrouter.ai/keys).

```bash
export OPENROUTER_API_KEY=sk-or-...
npx tsx examples/openrouter/index.ts            # run every snippet
npx tsx examples/openrouter/index.ts streaming  # run one
```

Snippets: `basic`, `streaming`, `compare`, `tools`, `agent-builder`, `models`,
`cost`, `errors`, `conversation`, `capabilities`.
