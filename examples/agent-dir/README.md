# agent-dir

An agent defined as a directory: `instructions.md` is the system prompt,
`tools/word_count.ts` is a `defineTool()` tool, `skills/tone.md` is a skill and
`agent.json` holds config. `index.ts` loads it with `loadAgentDir()` and swaps in
a scripted `mockModel`, so it runs offline.

```bash
npm run example:agent-dir
```

Drop the `provider` override and set `"model": "openai/gpt-4o-mini"` in
`agent.json` to run against a real model. Loading a directory executes its code,
so only load directories you trust. See [docs/agent-directories.md](../../docs/agent-directories.md).
