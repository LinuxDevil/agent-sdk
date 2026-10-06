# phase-pipeline

**Phase engineering** — a deterministic phase pipeline where the model fills each phase but the *order*, the *gate*, and what counts as *done* belong to the harness. The shape behind agentic-workflow repos (phases-oss, leeovery/agentic-workflows):

```text
discuss ──► spec ──► plan ──► implement ──► PROOF GATE ──► report ──► done
                               ▲               │
                               └── retry ──────┘ FAIL (bounded by maxRetries)
                                               │ PASS
```

Built entirely on `FlowBuilder` + `FlowExecutor`: each phase is an `llmCall` writing a named variable, the proof gate is a `toolCall` running a real check, and `oneOf` branches on the verdict.

## What this example had to learn about the executor

The runtime node set differs from the editor shapes — worth knowing before writing flows by hand:

- **No `loop` node and no early exit.** `loop` is editor-side; `sequence` runs *every* step, and `return` just resolves a value. The bounded retry ladder here is a chain of `oneOf` nodes, each guarding an implement+check attempt on `!check.startsWith('PASS')`. After a pass, the remaining attempts are no-ops.
- **`{{var}}` prompt interpolation is flat-keyed** (`\w+` — no `{{check.feedback}}`), while `oneOf` conditions use the full expression grammar (`check.startsWith('PASS')`, `check.passed === true`). Keeping the gate verdict a `'PASS: …' / 'FAIL: …'` string serves both surfaces.
- **`return`/`setVariable` take `$var` whole-variable references**, not `{{spec}}` bundles inside object literals — so a final *report* phase composes the deliverable, then `return: '$deliverable'`.

Run it:

```bash
npm run example:phase-pipeline    # offline, scripted phases + real node -e check
OPENROUTER_API_KEY=… npx tsx examples/phase-pipeline/index.ts
```

Related: [waves](../waves/) adds a verification spine to *parallel* work; this is the sequential phase version. [docs/prompting-techniques.md](../../docs/prompting-techniques.md) maps both in the pattern catalog.
