# repo-maintainer — audit findings

Harness: `index.ts` — a GitHub PR-review bot against the **packed** SDK
(`@lousho/build-ai-agent@1.0.0-alpha.18`, `file:./lousho-build-ai-agent-1.0.0-alpha.18.tgz`),
live on `openrouter/openai/gpt-4o-mini`.

- `webhookChannel({ name: 'github-pr', auth: { type: 'hmac', header: 'x-hub-signature-256' } })`
  receives a signed `pull_request.opened` payload; the whole JSON body becomes the turn input.
- `githubChannel({ webhookSecret, botName, token, fetch: <mock> })` serves the realistic
  `@mention` → approval-prompt comment → `/approve <id>` comment → review comment flow
  (GitHub REST calls recorded, no real token).
- Both mounted with `mountChannels` on one `node:http` server; approvals decided through the
  `POST /channels/<name>/approvals/:id` route (HMAC-verified too).
- Agent: `createFsTools(readOnly)` + `post_comment` (`needsApproval: true`, writes
  `.runs/<ts>/review-comment-N.json`) + 4 `deferLoading` tools + 1 `defineSkill`,
  `toolSearch: { thresholdPercent: 0 }`, `output` zod-4 schema, `hooks`, `onEvent`.

## Scoreboard (green run: `.runs/2026-10-08T10-31-12-540Z`, 19/19)

| Surface | Result | Evidence |
|---|---|---|
| Channel signature verify (`githubChannel.verify`) | PASS | valid `X-Hub-Signature-256` → 200; bad/missing/tampered → 401 (A1–A4) |
| Channel signature verify (`webhookChannel` hmac) | PASS | bad signature → 401 (A5) |
| Webhook intake → session turn | PASS | `pull_request.opened` body → run → `finishReason: awaiting-approval` in the HTTP response (B1) |
| Workspace fs tools | PASS | `read_file`/`glob`/`grep` over `NodeWorkspace` read the diff + repo every run |
| `output` structured output | PASS (with workaround, see F1) | `result.object = {verdict:'request_changes', issues:[3×critical], confidence:0.9}`; both planted bugs flagged (B4, B5) |
| Approval-gated `post_comment` | PASS | pause → `approvals/:id {approved:true}` → tool ran → file written → `stop` + object (B2, B3); deny → resumes, nothing written (C1, C2) |
| Tool search / progressive loading | PASS | `tool_search` found `lint_rules`/`style_guide` (`thresholdPercent: 0` forced deferral), tools callable next step (B6, B7) |
| Skills (`load_skill`) | PASS | `load_skill('pr-review-checklist')` called first in every run (B8) |
| `githubChannel` end-to-end | PASS | mention comment → approval prompt comment → `/approve` OWNER comment → "Approved by @dev-bob" + final review comment, all via injected `fetch` (D1–D4) |
| Hooks (`preToolCall` veto) | PASS | `one-comment-per-run` denied duplicate `post_comment` calls live |

## Bugs

### F1 — HIGH — `output` schema with any optional field → provider 400 on OpenAI-strict endpoints

`createAgent({ output })` → `outputResponseFormat()` (`src/execution/structuredOutput.ts:119`)
sends the schema as strict `json_schema`. `closeObjectSchemas` (same file, :78) already
patches `additionalProperties: false`, but nothing patches `required` — and OpenAI-strict
structured output requires `required` to list **every key in `properties`**, while zod 4's
`toJSONSchema` (via `schemaToJsonSchema`, `src/utils/zodCompat.ts:65`) omits optional keys.

Repro (packed SDK, live):

```ts
createAgent({ model: 'openrouter/openai/gpt-4o-mini', output: z.object({ s: z.string().optional() }) })
  .send('hi');
// => CompactedLLMProviderError: Provider returned error (HTTP 400)
// upstream: "Invalid schema for response_format 'r': 'required' is required to be supplied
//            and to be an array including every key in properties. Missing 's'."
```

Also fails for `z.number().optional()`, `z.number().int().optional()` — i.e. *any* optional
property. `z.number().int().nullable()` works (key stays in `required`, `anyOf:[type,'null']`).
This harness uses `.nullable()` for `issues[].line` as the workaround.

Fix: in `jsonSchemaOf`/`closeObjectSchemas`, normalize every object node so `required`
covers all `properties` keys (and wrap non-required properties in `anyOf` with `null`), or
document "optional fields are not supported on strict providers".

### F2 — MEDIUM — provider errors drop the upstream body

The 400 above surfaced only as `CompactedLLMProviderError: Provider returned error` with
`statusCode: 400` and `responseBody: undefined`. OpenRouter actually returned the precise
cause inside `error.metadata.raw` (the upstream OpenAI error). The SDK's error wrapper keeps
none of it, so the F1 diagnosis required replaying the request by hand. Suggestion: carry
`metadata.raw` (truncated) into the error message or a `details` field — never the API key.

### F3 — MEDIUM — mutating `ctx.messages` inside `preToolCall` breaks tool_call/result pairing

`ToolCallHookContext.messages` is documented as a "live reference" whose mutation "affects
the actual run" (`src/execution/hooks.ts:64`). Pushing a `{role:'user'}` message there during
`preToolCall` (to steer the model after a veto) landed it between the assistant `tool_calls`
message and the tool-result message the veto produces; the next model call 400'd with
`"Tool result is missing for tool call call_…"`, the run ended `finishReason: 'error'`, and
the `mountChannels` approvals route answered **500**. Suggestion: either reorder the veto
result before user-supplied mutations, document that `ctx.messages` may only be mutated in
`preGenerate`, or normalize the pairing after hooks run. (Harness no longer mutates; the
crash is preserved in `.runs/2026-10-08T10-26-39-041Z/http.jsonl`.)

## Enhancements / papercuts

- **E1 — `tool_search` result semantics invite fishing.** `{loaded: [], more: 3}` means "0
  matched this query, 3 deferred tools remain unloaded" — gpt-4o-mini reads `more` as "keep
  searching" and burned ~20 steps on queries like "null check user". Consider renaming
  `more` → `remainingDeferred`, including the not-yet-loaded tool names, or an explicit
  "no match — do not retry" hint when `loaded` is empty.
- **E2 — `githubChannel` cannot intake `pull_request.opened`.** `parse` only acts on
  `issue_comment` / `pull_request_review_comment` (`src/channels/githubChannel.ts:363`) and
  acks everything else with `200 {ok:true}` — verified live (A1). Consistent with its docs,
  but a real PR-review bot needs `pull_request` events; today you must wire `webhookChannel`
  yourself (as this harness does) and lose session threading/`/approve`. Consider a
  `pull_request` event mode that keys sessions by `owner/repo#number`.
- **E3 — `WebhookTriggerAdapter` is deprecated** in favor of `webhookChannel` + `mountChannels`;
  fine, just flag that the deprecated path is still exported from `/triggers`.
- **E4 — channel reply posts the raw `result.text`.** With an `output` schema the final
  GitHub comment is the raw JSON object — correct but ugly; a `reply`-time formatter hook
  (or posting `result.object` rendered) would help bot surfaces.
- **E5 — model-behavior caveat (not an SDK bug):** gpt-4o-mini sometimes re-emits the just
  -approved `post_comment` call (identical args) or retries a denied call until `max-steps`.
  The resumed transcript does contain the tool result (verified via `preGenerate` dump), so
  this is the model's loop, not an SDK resume bug — but it makes approval-gated bots on small
  models fragile. A directive tool result ("POSTED… final answer only") plus a vetoing hook
  mostly tames it; the deny path still ran to `max-steps` in one run (C1 passed, noted).

## What worked well

- `mountChannels` + `channelCore`: verify → parse → session turn → reply, per-session
  serialization, the `approvals/:id` route delivering the continuation's `ExecutionResult`
  as the HTTP response — the whole pause/approve/post flow is one clean HTTP exchange.
- `webhookChannel` HMAC auth (`x-hub-signature-256`, constant-time compare) and
  `githubChannel` Web-Crypto signature check both correctly accepted the good signature and
  rejected bad/missing/tampered ones.
- `agent.session` per `sessionKey` isolates PRs; `principal` maps through from the verified
  sender. `onEvent` sees every event of session turns (handy for auditing).
- `needsApproval: true` pause → `approval.requested` event with id → resume on approval:
  `tool.resume` re-fires the exact call once (`ctx.resumedAfterApproval` distinguishes it).
- `toolSearch: { thresholdPercent: 0 }` forces deferral deterministically for testing;
  `defineSkill` + auto `load_skill` works out of the box.
- `createFsTools(readOnly)` gives a reviewer exactly the right toolset; missing files and
  bad globs come back as recoverable tool errors, not run failures.

## Artifacts

- `.runs/<ts>/audit.jsonl` — every `AgentEvent` (phase-tagged), hook vetoes, channel errors
- `.runs/<ts>/http.jsonl` — every HTTP request/response + recorded GitHub API posts
- `.runs/<ts>/review-comment-N.json` — what `post_comment` wrote after approval
- `.runs/<ts>/summary.json` — check results, event counts, tool_search results, GitHub posts
- `.runs/<ts>/repo/` — the scratch checkout (fixture copy) the agent reviewed
