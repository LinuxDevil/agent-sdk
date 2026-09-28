# doc-qa

A question-answering agent scoped to a single fixed document (a short
refund policy, inlined in the prompt), built with `createAgent()`.

Runs against a free local mock provider by default - no API key needed.
Set `OLLAMA_BASE_URL` to run it against a local Ollama instead.

```bash
npx tsx examples/doc-qa/index.ts
```
