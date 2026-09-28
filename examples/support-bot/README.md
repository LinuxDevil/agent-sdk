# support-bot

A minimal customer-support agent built with `createAgent()`. Empathetic,
concise, and always asks for an order number when a customer reports a
problem.

Runs against a free local mock provider by default - no API key needed.
Set `OPENAI_API_KEY` to run it against real OpenAI instead.

```bash
npx tsx examples/support-bot/index.ts
```
