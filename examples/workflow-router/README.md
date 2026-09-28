# workflow-router

An agent that classifies an incoming request into one of a fixed set of
categories (`billing`/`technical`/`sales`), built with `createAgent()`.

Runs against a free local mock provider by default - no API key needed.
Set `OPENAI_API_KEY` to run it against real OpenAI instead.

```bash
npx tsx examples/workflow-router/index.ts
```
