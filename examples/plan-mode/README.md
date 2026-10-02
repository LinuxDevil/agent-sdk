# plan-mode

Plan first, then let the agent edit: a coding agent over a `MemoryWorkspace`
with `createFsTools()`. The first turn runs with `permissionMode: 'plan'`, so
the agent may read files but every write is refused and it proposes the
change instead. Then `session.setPermissionMode('acceptEdits')`, and the
second turn applies the plan: file edits run without asking for approval.

Runs offline with a scripted mock model - no API key needed. Set
`OPENROUTER_API_KEY` to run it against `openai/gpt-4o-mini` through
OpenRouter instead.

```bash
npx tsx examples/plan-mode/index.ts
```

See [Permission modes](../../docs/permission-modes.md).
