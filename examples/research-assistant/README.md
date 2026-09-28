# research-assistant

An agent with the built-in `http` tool wired up so it can fetch sources
while researching a question, built with `createAgent()`.

Runs against a free local mock provider by default - no API key needed.
Set `ANTHROPIC_API_KEY` to run it against real Anthropic instead.

```bash
npx tsx examples/research-assistant/index.ts
```
