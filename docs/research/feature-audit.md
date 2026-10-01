# Feature audit: @loushy/build-ai-agent (1.0.0-alpha.8)

Read-only audit of the code at `E:\agent-sdk`, HEAD `1d733ae` (LOU-T5). Method: reading source, README/docs, and grep. One throwaway probe (an `ai` v4 `MockLanguageModelV1` run from a temp file, deleted afterwards) confirmed headline defect 2. No test suites were run. Status key: real = works end to end, partial = works with material holes, stub = exists but not wired or functional, missing = absent.

Note on repo state: at audit time `git status` showed uncommitted edits to `package.json`, `package-lock.json`, `apps/agent-forge/package.json`, `bin/loushy.js`, `packages/create-loushy-agent/bin/cli.js`, and an untracked `.fallowrc.json`. These are not from this audit (it only wrote this file). Something else is editing the tree concurrently.

Size: about 18.2k non-test lines in `src/`, 71 test files and about 807 `it`/`test` cases in `src/`, plus 24 test files in `apps/agent-forge`. Coverage floors are low (statements and lines 61%). The measured baseline in `vitest.config.ts` is 71% statements, 82% branches.

---

## 0. Headline defects (verified in code)

1. **Model selection is broken on the zero-config path.** `src/execution/AgentExecutor.ts:407` sends `model: agent.settings?.model || 'gpt-4'` on every generate call. Every provider then does `options.model || config.defaultModel || <hardcoded>` (for example `AnthropicProvider.ts:77`), and `options.model` is always truthy. So `resolveProvider('openai/gpt-4o-mini')`, `resolveProvider('anthropic/claude-sonnet-5')` and `AgentSpec.provider.model` never take effect unless the caller also calls `AgentBuilder.setSettings({ model })`. `createAgent()` has no model option and `specToAgent`/`prepareSpecExecution` never set one. On Anthropic, Ollama or OpenRouter the request would carry the model name `gpt-4`. No test asserts the model sent. The README hello-world is therefore wrong for non-OpenAI providers, and silently uses `gpt-4` for OpenAI.
2. **Multi-step tool use drops the assistant tool-call turn on 3 of 4 real providers.** `OpenAIProvider.ts:28`, `AnthropicProvider.ts:32` and `OllamaProvider.ts:27` `convertMessages()` pass `toolCalls` as an extra field on the assistant message, which the `ai` v4 `CoreMessage` format ignores. I confirmed with an `ai` v4 `MockLanguageModelV1`: the prompt the model sees has `assistant: [{type:'text', text:''}]` followed by a `tool` result with no matching tool-call part. Real OpenAI and Anthropic APIs reject that shape. Only `OpenRouterProvider.ts:47` builds proper `tool-call` parts. The mock provider hides this, so tests and docs pass.
3. **`eval()` in the flow engine.** `src/flows/FlowExecutor.ts:631` and `:643` `eval()` the `{{var}}`-interpolated condition or expression. Variables hold LLM output and user input, so this is a code-injection path in the host process. The comment at `:629` says "In production, use a safe expression evaluator".
4. **Tool arguments are never validated against the tool's zod schema.** `src/execution/sandboxGuard.ts:55` calls `tool.execute(args, {} as any)` with raw `JSON.parse` output. Malformed JSON from the model becomes `{}` (`AgentExecutor.ts:859`) and the tool runs with empty args. The execute context is an empty object (no `toolCallId`, `messages`, or `abortSignal`).
5. **No abort, no streaming, no structured output in the SDK core** (section 1).
6. **Peer dependencies are three majors stale** (section 12).

---

## 1. Agent definition and run loop (`src/core`, `src/execution`, `src/createAgent.ts`)

Status: **partial (real loop, thin feature set)**.

Key files: `src/execution/AgentExecutor.ts:266` (static `execute`), `:303` (`runAgentLoop`), `:402` (while loop), `:559-688` (tool-call branch), `src/createAgent.ts:60`, `src/core/AgentBuilder.ts`, `src/types/agent.ts`.

Public API:
```ts
const agent = createAgent({ prompt, provider, tools?, name?, maxSteps? });
const r = await agent.send('Hello');            // ExecutionResult
// or
const r = await AgentExecutor.execute({ agent, input, provider, toolRegistry, maxSteps, onEvent, ... });
```

What is real:
- Loop with `maxSteps` (default 10), tool calls, usage accumulation, `finishReason`, a nested span tree, and `onEvent` for start / text-complete / tool-call / tool-result / finish / error.
- Provider-error compaction (`CompactedLLMProviderError`) with an opt-in `surfaceRetryableProviderErrors`.
- Clear validation errors for a missing `provider`, `agent` or `input` (`:1029`).

Weaknesses:
- **No cancellation.** There is no `AbortSignal` option anywhere in `src/` outside `http.ts`. Agent Forge fakes it with `withAbortSignal(provider, signal)` (`apps/agent-forge/server/abortableProvider.ts`), which only checks between provider calls. In-flight HTTP and tool execution are not cancelled.
- **No streaming through the executor.** `ExecuteOptions.streaming` is declared (`:91`) but never read. `'text-delta'` is in `ExecutionEventType` (`:50`) but never emitted. `provider.stream()` exists on every provider and nothing in the loop calls it. The file header still claims "streaming support".
- **No structured output.** No `generateObject`, `responseFormat`, `outputSchema`, JSON mode or schema-validated final answer. `Message.content` is `string` only, so there is **no multimodal input** (images, files, audio). `toolChoice` exists on `GenerateOptions` but the executor never sets it.
- **Tool calls run sequentially** (`for` loop at `:570`), not in parallel.
- **Mid-batch approval bug.** If tool call 2 of 3 needs approval, the loop returns at `:645`. The assistant message with all 3 tool calls is already pushed, but tool results exist only for call 1. Call 3 is dropped, and the snapshot holds an assistant turn with unanswered tool_call ids. Resuming would send an invalid transcript to OpenAI or Anthropic.
- **`maxSteps` exhaustion is silent.** The loop exits and returns the last `finishReason` (often `tool_calls`) with `text` possibly empty. There is no `'max-steps'` finish reason or error. Approval-resume steps count against `maxSteps` via `initialSteps`.
- No stop conditions beyond `maxSteps` and the model's own stop (no stop-on-tool, no custom predicate, no token or cost budget, no wall-clock timeout).
- `AgentConfig` carries inert concepts: `agentType` (SmartAssistant / Survey / Commerce / Flow) changes no behavior; `flows`, `events`, `expectedResult`, `locale` are unused by the executor.
- `createAgent().send()` is single-turn and stateless: no history, no `sessionId`, no approval store, no checkpoint store, no hooks, no `onEvent`, no abort. Everything beyond hello-world requires dropping to `AgentBuilder` plus the static `AgentExecutor`. A static class cannot be mocked or subclassed, which is an awkward API.
- `any` in public types: `buildTools(): any[]`, `ExecutionEvent.toolResult.result: any`, `AgentConfig.expectedResult/events/settings`.
- Registries use `console.warn` on duplicates rather than the SDK `Logger`.

Tests: `AgentExecutor.test.ts`, `createAgent.test.ts`, `AgentBuilder.test.ts`, `errors.test.ts`. Substantial, but mock-provider only. They never assert the model sent, nor real-provider message conversion.

## 2. Tools (`src/tools`, `src/types/tool.ts`)

Status: **partial**.

Key files: `src/tools/ToolRegistry.ts`, `src/types/tool.ts:36` (`ToolDescriptor`), `src/tools/built-in/*`, `src/execution/sandboxGuard.ts`.

Definition API:
```ts
registry.register('weather', { displayName: 'Get weather',
  tool: tool({ description, parameters: z.object({...}), execute }),   // Vercel `ai` tool()
  needsApproval: (args) => boolean | Promise<boolean>, requiresSandbox, sandboxExecute });
```
- **Tools are Vercel `ai` `Tool` objects.** There is no SDK-native `defineTool()`. Users must import `tool` from `ai` v4 (v5+ renamed `parameters` to `inputSchema`, so the surface is tied to a legacy major).
- **Validation:** zod only declares parameters. There is no runtime parse of model args (headline 4). Tool errors are caught and returned to the model as `{error: message}`, which helps self-correction, but there is no structured error class, no retry and no per-tool timeout.
- `PropagatingToolError` is the only way for a tool to abort the run.
- `ToolRegistry.register` warns via `console.warn` on duplicate names and has no namespacing.
- **Built-ins:** `currentDate`, `dayName`, `http` (365 lines; SSRF denylist for loopback, RFC1918 and cloud-metadata IPs, per-request TLS via undici; real), `email` (Resend only), `slack` (webhook alert), `github` (1,712 lines, `createGitHubTools(config)`), `jira` (1,157 lines, `createJiraTools(config)`). All real, but github and jira are credentialed factories that the declarative spec cannot reference (`specToAgent.ts` throws "needs credentials"). **No** filesystem, shell, web search, code-exec, browser or computer-use tools.
- **Approval (HITL):** real. `needsApproval` (bool or function) pauses the run, saves an `ExecutionSnapshot`, and `resumeAfterApproval()` continues (`src/execution/resume.ts:85`). Gaps: no "approve with edited args", no remember-this-choice or allowlist, no timeout or expiry, no multi-approver. `ApprovalStore.resolve()` **deletes the record on read** (`ApprovalGate.ts`), so a crash after resolve and before execution loses the pause. Only the executor path supports approvals (`FlowExecutor` has none).
- **README bug:** the README shows `resumeAfterApproval({id, approved}, approvalStore, provider, registry)` twice, but the actual signature is `(decision, approvalStore, toolRegistry, provider, executeOptions?, checkpointStore?)` (`resume.ts:85`). Following the README swaps `provider` and `toolRegistry`.
- `ToolDescriptor.injectStreamingController` is unused.

Tests: `ToolRegistry.test.ts`, `http.test.ts`, `github.test.ts`, `jira.test.ts`, `slack.test.ts`, `index.test.ts`, `ApprovalGate.test.ts`, `resume.test.ts`, `sandbox-wiring.test.ts`. **No tests** for `email.ts`, `currentDate.ts`, `dayName.ts`, `sandboxFetch.ts`, `sandboxGuard.ts`.

## 3. MCP (`src/tools/mcp`)

Status: **partial (client tools only)**.

Files: `McpToolLoader.ts` (`loadMcpTools(client, connectionName)`), `schema.ts` (`jsonSchemaToZod`), exported at `@loushy/build-ai-agent/mcp`.
```ts
const tools = await loadMcpTools(mcpClient, 'linear');   // Record<`${conn}__${tool}`, ToolDescriptor>
registry.registerMany(tools);
```
- The caller must create and connect the `@modelcontextprotocol/sdk` `Client` and pick the transport themselves. There is no `connectMcp({command|url})` helper, no lifecycle or close management, no reconnect, and no `mcp:` field in `AgentSpec`.
- `jsonSchemaToZod` supports only `type` object/array/string/number/integer/boolean and `enum`. It **throws** on `$ref`, `oneOf` / `anyOf` / `allOf`, nullable, `const`, and a missing `type`; `default`, `format` and `additionalProperties` are silently dropped. `loadMcpTools` converts every tool, so one unsupported schema fails the whole server load (`McpToolLoader.ts:70-71`). This is a significant real-world compatibility hole, since many MCP servers emit `anyOf`.
- The `callTool` result is returned raw: no `isError` handling, no content-block flattening (text, image, resource), no output-schema use.
- No MCP resources or prompts, sampling, elicitation or auth. MCP tool annotations (`destructiveHint`, `readOnlyHint`) are ignored, so there is no approval default for destructive tools.
- **No MCP server mode** (cannot expose an agent or its tools as an MCP server).
- The README documents an import path (`@loushy/build-ai-agent/tools/mcp/McpToolLoader`) that is not in `package.json` `exports`. The working paths are `/mcp` or the root.

Tests: `McpToolLoader.test.ts`, `loadMcpTools.test.ts`, `schema.test.ts` (mocked `Client`; no real-server integration test).

## 4. Providers, routing, retries, cost (`src/providers`)

Status: **partial**.

Files: `llm.ts` (interface and `LLMProviderRegistry`), `OpenAIProvider.ts`, `AnthropicProvider.ts`, `OllamaProvider.ts`, `OpenRouterProvider.ts`, `mock.ts`, `resolveProvider.ts`.
- Four real adapters via `ai` v4, `@ai-sdk/*` 0.0.42 and `ollama-ai-provider`. OpenRouter reuses the OpenAI SDK. **No Google, Bedrock, Azure, Mistral, Groq, xAI or generic OpenAI-compatible provider**, other than via OpenRouter or a `baseURL` hack.
- `resolveProvider('provider/model')` is a nice DX touch (env-var lookup). A missing key gives `apiKey: undefined` and the failure is deferred to the first call.
- **Model-name bug** (headline 1): provider `defaultModel` is effectively unreachable through the executor.
- **Tool-turn serialization bug** (headline 2).
- **Retries:** `LLMProviderConfig.maxRetries` and `.timeout` are declared (`llm.ts`) but read nowhere in `src/providers/*`. Retry behaviour is the `ai` SDK's implicit default (2 retries). `src/execution/retry.ts` (`retry`, `retryOnError`, `RetryableOperation`, 304 lines) is exported but **used nowhere** in the executor or providers.
- **Fallbacks and routing:** none. No fallback chain, model router, cost- or latency-based routing, or circuit breaker. `LLMProviderRegistry` is a global static map.
- **Usage and cost:** prompt, completion and total tokens accumulate in `ExecutionResult.usage`. **No cost computation, no price table, no cache-token or reasoning-token fields, no budget enforcement.** `security/quotas.ts` (`validateTokenQuotas`) is a leftover SaaS-quota helper (`allowedUSDBudget`, `emailVerified`) that nothing calls. `evals.budget()` can assert limits only after the fact.
- Each adapter duplicates about 60 lines of conversion code with `any`-typed params (`convertMessages(): any[]`, `tools: Record<string, any>`, `rawResponse?: any`). The "placeholder `execute` returning null" pattern is repeated 8 times.
- `supportsTools()`, `supportsStreaming()` and `getModels()` are on the interface, but the executor never consults them.
- No reasoning/thinking config, prompt caching, `providerOptions` passthrough, or use of `topP`/`seed` from the executor.

Tests: one test file per adapter plus `resolveProvider.test.ts` and `llm.test.ts`. The provider tests mock the `ai` package. `mock.ts` has no sibling test.

## 5. Memory, sessions, persistence, context window

Status: **stub / partial**. This is the biggest functional gap versus competitor harnesses.

- `MemoryManager` (`src/execution/MemoryManager.ts`) and `ContextBuilder` (`ContextBuilder.ts`) are exported but **not referenced by `AgentExecutor`, `createAgent`, `resume`, or `FlowExecutor`** (grep: only `execution/index.ts` re-exports them). They are standalone utilities. `MemoryManager.recall()` uses word-overlap text similarity (`calculateTextSimilarity`) or caller-supplied embeddings; there is no embedding generation and no vector store.
- `ContextBuilder` truncates by message count (`maxHistoryMessages = 20`). **There is no token counting, no context-window awareness, no summarization or compaction, no trimming strategy** anywhere in `src/`. A grep for `summar|truncat|compact|contextWindow` finds only the provider-error compactor. Overflow surfaces as the `'context-length-exceeded'` error category and nothing handles it automatically.
- **Sessions/threads:** `sessionId` exists only as a checkpoint key. The conversation is not persisted across `send()` calls, and a completed run **deletes its checkpoint** (`AgentExecutor.ts:749`), so there is no thread history store. Agent Forge adds its own file-based `chatStore.ts` outside the SDK.
- `src/data` defines `AgentRepository`, `SessionRepository`, `ResultRepository`, `MemoryRepository` and `AttachmentRepository` **as interfaces only** (`repositories.ts`), plus in-memory mocks exported from `/testing`. **No real DB adapter.** The README roadmap lists Drizzle, Prisma and Mongo as pending, but there is no Drizzle code in `src`. `models.ts` has about 20 `any`s.
- `StorageService` (`src/storage`) is a local-filesystem blob store with advisory file locks (injected `fs`/`path`). It backs `LocalStorageCheckpointStore` and `StorageServiceApprovalStore`. It is Node-only and single-host. The only other `CheckpointStore` is `KVCheckpointStore` for Cloudflare (`src/deploy/kvCheckpointStore.ts`).

Tests: `MemoryManager.test.ts`, `ContextBuilder.test.ts`, `StorageService.test.ts`, `mocks.test.ts`. `repositories.ts` has no test (types only).

## 6. Checkpoints, durable execution, pause/resume

Status: **real but narrow**.

Files: `src/execution/checkpoint.ts` (`CheckpointStore`, `LocalStorageCheckpointStore`, `Checkpoint` with `businessState`), `AgentExecutor.ts:344-386` (rehydrate), `:670-682` (save), `resume.ts`, `src/deploy/kvCheckpointStore.ts`, `apps/agent-forge/server/checkpointStore.ts`.
- A checkpoint is saved **only after each tool result**, never after a plain LLM turn. A crash during a long generation, or on a run with no tools, loses all progress.
- Rehydration ignores the new `input`. Calling `execute({ sessionId, input: 'continue' })` after a crash resumes the old transcript and the new input text is silently dropped (the README example is misleading; there is no way to append a user message to a resumed run).
- No idempotency protection for tools executed after the last save and before the crash, no run ids, no versioning or migration of checkpoint records, no TTL or cleanup, and no lock between two executors on one `sessionId` (the file store locks writes only).
- Not a workflow engine: no Temporal, Inngest or Durable Objects integration, no timers or sleeps, no waits for human events beyond approvals, no per-step retries.
- Pause/resume across approvals is solid apart from the mid-batch defect (section 1). It restores `businessState` and `initialSteps`.

Tests: `checkpoint.test.ts`, `resume.test.ts`, `kvCheckpointStore.test.ts`, `cloudflare.checkpoint.test.ts`.

## 7. Sub-agents, handoff, orchestration, flows

Status: delegation **partial**; flows **partial and inconsistent**; handoff **missing**.

Delegation (`src/execution/DelegationTool.ts`):
```ts
registry.register('delegate_billing', createDelegateTool({ agent, provider, contextMode: 'none' | 'full-history', maxSteps, maxDepth: 3 }));
```
- Real: a child agent as a tool, a depth guard via `AsyncLocalStorage` (works on Node; other runtimes need `nodejs_compat`), and `DelegationDepthExceededError` propagates (`PropagatingToolError`).
- The child `execute()` call does **not** inherit `hooks`, `exporter` (so child spans are not linked to the parent trace), `sandbox`, `approvalStore`, `onEvent`, abort, `sessionId` or `checkpointStore`. A child tool that needs approval throws "requires approval but no approvalStore". Child token usage comes back inside the tool result but is **not added** to the parent's `usage`. The `context` param is model-supplied, so the LLM can fabricate prior history.
- **No handoff** (transfer of control to another agent), no supervisor, router or swarm patterns, no parallel fan-out of agents, no shared state. Router-style branching exists only in Agent Forge (section 12).

Flows (`src/flows`, `src/types/flow.ts`):
- **The type model and the executor disagree.** `EditorStep` (`types/flow.ts`) defines `step | sequence | parallel | oneOf | forEach | evaluator | bestOfAll | tool | uiComponent | condition | loop`. `FlowExecutor.executeNode` (`FlowExecutor.ts:185-216`) handles `sequence | parallel | oneOf | forEach | evaluator | llmCall | toolCall | setVariable | return | end | throw`. So `step`, `tool`, `bestOfAll`, `condition`, `loop` and `uiComponent` throw "Unknown node type", while `llmCall`, `toolCall`, `setVariable` and `end` are not in the `EditorStep` union (the executor types nodes as `any`; about 60 `any`s in `FlowExecutor.ts`).
- The `evaluator` node ignores `criteria`, `subFlow` and `max_iterations` from its type; it just evals `node.expression`.
- `src/flows/converters.ts` converts `EditorStep` to a "flows-ai FlowDefinition" for an engine that is neither a dependency nor used by `FlowExecutor` (dead donor-project code).
- **The README `FlowBuilder` example is wrong.** It shows `.addNode()`, `.addEdge()` and `type: 'conditional'`, but `FlowBuilder` only has `setFlow`, `addAgent`, `addInput` and similar (`FlowBuilder.ts`).
- `FlowExecutor` has no checkpointing, approvals, hooks or tracing (acknowledged in `apps/agent-forge/server/runRegistry.ts:641-655`). `interpolate` accepts `\w+` only (no nested paths) and renders missing or falsy values such as `0` or `false` as `''`. Step ids use `step-${Date.now()}` and can collide.

Tests: `FlowBuilder.test.ts`, `FlowExecutor.test.ts`, `converters.test.ts`, `inputs.test.ts`, `validators.test.ts`, `DelegationTool.test.ts`.

## 8. Hooks, middleware, guardrails, security, sandboxing

Hooks (`src/execution/hooks.ts`, export `/hooks`): **real, limited.** `AgentHook` has `preToolCall`, `postToolCall`, `preGenerate`, `postGenerate`; `HookRegistry` runs them in order.
- Hooks can mutate `ctx.args` (honoured, `AgentExecutor.ts:964`) or throw to abort the **entire run**. There is no "deny this tool call and tell the model" outcome, no skip, and no replace-result. The docs claim hooks "can mutate args/messages/results", but `postToolCall` receives a throwaway copy of `{result, error}`, so mutating results has no effect.
- `preGenerate` runs outside the `llm.generate` span; `postGenerate` runs inside it. `preToolCall` args are `{}` on unparsable JSON.
- No middleware chain (`next()`), no `onStep`, no per-agent versus global scoping, no streaming hooks. Agent Forge compiles user JS hooks and runs them in a subprocess via `new Function` (`apps/agent-forge/server/hookSandbox.ts`), which is process-level isolation only.

Guardrails (`src/execution/guardrails.ts`): **real but narrow and mis-scoped.** `Guardrail.check(action: { diff: string })`; built-ins are `secretScanGuardrail`, `createDiffSizeGuardrail` and `createCommandGuardrail` (runs tests or lint). They are patch gates for the ops-pipeline demo. There are **no input or output guardrails** (PII, prompt injection, moderation, topic), no tripwires on the agent loop, and nothing wires them into `AgentExecutor`. `spec.policy.guardrails: string[]` is validated by the schema and **never resolved or enforced**. The same holds for `spec.policy.requiresApproval` (grep: used only by the claude-code, codex and pi doc generators).

Security and sandbox:
- `SandboxAdapter` (`sandboxCore.ts`), `NoopSandbox` (zero isolation, the default), `SubprocessSandbox` (`sandbox.ts`; **it is actually Docker via `dockerode`**, so the name misleads). Fail-closed when `requiresSandbox` is set without `sandboxExecute`. Real and tested, but opt-in per tool, so nothing is sandboxed by default.
- `EncryptionUtils`, `DTOEncryptionFilter`, `sha256` (`crypto.ts`): real (random salt after a breaking change). Only tangentially relevant to agents.
- The `http` tool has an SSRF denylist. `loushy dev` caps request bodies at 1 MB.
- `WebhookTriggerAdapter` binds `0.0.0.0` by default with no auth or signature check (grep: no `secret|hmac|signature|token`). `SlackTriggerAdapter.handleEvent` does no Slack signing-secret verification; that is left to the caller.
- No permission model (tool allow/deny lists, filesystem or network scopes) and no secret redaction in traces other than `redactContent`.
- Heavy hard dependency: `dockerode` (with a native ssh2 subtree) is a regular dependency for every consumer.

Tests: `guardrails.test.ts`, `hooks.test.ts`, `sandbox.test.ts`, `SubprocessSandbox.test.ts`, `crypto.test.ts`, `quotas.test.ts`, `sandbox-wiring.test.ts`.

## 9. Skills, templates, agent types, spec generators

- **Skills (SKILL.md style, progressive disclosure): missing.** No skill loader, registry or discovery.
- **Prompt templates** (`src/templates`): a real Jinja-like engine (`{{ var|filter }}`, `{% if %}`, `{% for %}`; tokenizer plus block parser). `if` supports only a truthy check of a variable path (`TemplateManager.ts:38`, "very naive approach"; no comparisons, `and` or `or`). The executor never renders `agent.prompt` through it; `renderTemplate` is a standalone helper.
- **Agent types** (`src/agent-types`): a static list of 4 enum entries with Arabic and English descriptions (donor-project residue) and no behavioral effect. `registry.ts` and `validators.ts` have no tests.
- **Spec** (`src/spec`): `AgentSpec` is `name, prompt, provider{type,model}, tools[], policy, triggers[]`. The YAML/JSON loader gives clear field-level zod errors (`loadSpec.ts`). `specToAgent` honours only name, prompt, provider and tools; `policy` and `triggers` are accepted and ignored (except by Agent Forge's own hook compile). The spec has no `maxSteps`, temperature, `mcp`, memory, `sandbox`, sub-agents or env/secret refs. Only built-in tools `http`, `current-date` and `day-name` resolve by name.
- **Generators** (`src/spec/generators`): `claude-code.ts`, `codex.ts` and `pi.ts` render the spec into other harnesses' config formats. Real and tested with fixtures. They are not exported anywhere: `src/spec/index.ts` does not re-export `generators`, and `package.json` has no `./spec` subpath.

## 10. Triggers and deploy targets

Triggers (`src/triggers`, export `/triggers`): **real, shallow.** `TriggerAdapter { type, listen(agent, onEvent), reply? }`, `TriggerRegistry` (plus a global instance), and these adapters:
- `CronTriggerAdapter` is **interval-only** (`intervalMs`): no cron expressions, no timezone, no schedule persistence.
- `WebhookTriggerAdapter` uses node `http` with no auth (section 8).
- `SlackTriggerAdapter` is a passthrough: it does not subscribe to Slack; the caller feeds `handleEvent()` and replies go via an incoming-webhook URL (no thread replies or Web API).
- No email, GitHub, queue (SQS, Pub/Sub), file-watch or MCP-notification triggers. A Grafana/Datadog trigger exists only in `examples/ops-pipeline/monitor.ts`. Spec `triggers:` are not instantiated by `loushy dev` or `build`.

Deploy (`src/deploy`, `loushy build --target=`): **real for 3 targets.**
- `node-server`, `docker` and `cloudflare-worker` adapters generate a bundled server (tsup required at build time; `tsup` is oddly listed as a peer dep of a runtime SDK). The node-server and dev server expose `POST /chat` and `/health` only: **single-turn, no history across requests, no streaming (SSE), no auth, no approval endpoints, no session routes.**
- Cloudflare: providers `mock/openai/anthropic` only (Ollama and OpenRouter unsupported); tools only `current-date` and `day-name`; checkpointing via an optional KV binding; a bundle-size report against the 64 MB limit. The README roadmap line "currently mock-provider only" is stale (LOU-K3 shipped OpenAI and Anthropic).
- No Vercel, AWS Lambda, Deno Deploy, Fly or Kubernetes adapters. `bundle.ts`, `runtime.ts`, `runtime.worker.ts` and `specExecution.ts` have no sibling tests (adapter tests cover them partly).

## 11. Evals, testing utilities, observability

Evals (`src/evals`): **real, minimal.** `defineEval({ name, agent, input, provider, toolRegistry, score, threshold })` registers a vitest `test`. Scorers: `exactMatch`, `toolCallOrder`, `budget`, `llmJudge` (real-LLM judge, run via `vitest.judge.config.ts`). Gaps: single-turn input only, one score per eval, no datasets or cases, no multi-trial or variance, no result store or regression diffing, no trajectory or semantic-similarity scorers, and vitest-only (relies on the `__vitest_index__` global). `defineEval` passes only some `ExecuteOptions` through (no `hooks`, `sandbox`, `sessionId`, `exporter`). `defineEval.ts` has no sibling test.

Testing utilities (the `./testing` export maps to `src/data/mocks.ts`): this exports **repository mocks only**. The useful `createMockProvider()` and `MockLLMProvider` live on the main entry. The mock provider cycles canned strings and fakes a tool call whenever the user message mentions a tool's name (a hack that hid headline defect 2). There is no scripted-turns builder, no record/replay of real traffic, no fake clock, and no `assertToolCalled` helpers. The `testing` subpath name is misleading.

Observability:
- Tracing: `withSpan` plus `TraceExporter { onSpanStart, onSpanEnd }`; a 3-level span tree (`agent.run` > `llm.generate` / `tool.call`); a `redactContent` flag. `createOtelTraceExporter` (`/otel`, optional `@opentelemetry/api`) bridges to OTel; real and tested (`otel.test.ts`, `examples/tracing`).
- Gaps: attributes use ad-hoc names (`promptTokens`, `toolName`), **not the OTel GenAI semantic conventions** (`gen_ai.*`); no metrics; no `FlowExecutor` tracing; delegated child agents emit no linked spans; an `onSpanEnd` that throws would propagate from the `finally` block.
- Logging: a `Logger` interface and `noopLogger` exist and are used only by two providers (Ollama, OpenRouter). The executor does not log, there is no log-level config, and several modules call `console.warn` directly.
- Agent Forge adds a debug console (logs, span waterfall, step debugger) and a WebSocket event stream on top of `onEvent` and `exporter`.

## 12. CLI, scaffolder, Agent Forge, DX

CLI (`bin/loushy.js` calls `dist/cli/*`): `loushy dev <spec>`, `loushy build --target= --agent= [--out]`, `loushy studio [--port --host --prod|--dev]`.
- **No** `init`, `run` (one-shot), `chat` (terminal REPL), `eval`, `deploy`, `logs`, `doctor`, `add tool`, or `--help` beyond the usage string. Arg parsing in `bin/loushy.js` is hand-rolled (`rest.find(arg => arg.startsWith('--port'))`), which is fragile.
- `loushy dev`: hot reload via `fs.watch` on a single file, a stateless `/chat` that calls `agent.send()` per message (**no conversation memory; each message is a new conversation**), no streaming, no tool-call visibility, no approval UI. The chat UI is one static HTML file.
- A test-only `'stub'` deployment adapter is registered in the production CLI path (`src/cli/build.ts:69`).

Scaffolder (`packages/create-loushy-agent`, v0.1.0): prompts (name, provider, tools), then writes package.json, tsconfig, `src/agent.ts` and `.env.example`. It only knows `openai | anthropic | ollama` (no openrouter) and tool `http` (`github` is left as a TODO comment). **It runs `npm pack` on the SDK from a sibling checkout (`findSdkRoot` = `../../..`) and installs a `file:` tarball**, so it cannot work from a published install. Its `package.json` `files` lists a `templates` directory that does not exist. The SDK is **not on npm** (`npm view @loushy/build-ai-agent` returns 404), yet the README shows an npm badge and `npm install @loushy/build-ai-agent`.

Agent Forge (`apps/agent-forge`, a private workspace shipped inside the SDK tarball via `files`): **real, and the most complete product surface.** It has a React Flow canvas (trigger / llm / tool / approval / output / router nodes), `graphToSpec` / `specToGraph` / `graphToFlow`, an Express and WebSocket runtime control server (run, stop, status, approve, debug step/continue), chat with persisted sessions and approval cards, settings (providers, profiles, secrets store, deploy runner), a hook editor with sandboxed hooks, a file-based agent store under `.loushy/`, and Playwright e2e (`e2e/studio.spec.ts`). Limits:
- Router nodes route through `FlowExecutor`, which lacks approvals, checkpoints, hooks and abort (documented in `runRegistry.ts`), so a graph with a router silently loses those features.
- `runRegistry.ts` is 876 lines.
- Local single-user only (no auth, multi-tenant or remote). The secrets store is file-based.
- `fsAgentStore.ts` carries `TODO(LOU-N)`.
- Forge's limitations come straight from the SDK gaps above (no streaming, no real cancel).

DX:
- **Hello-world** is 7 lines (README quickstart):
  ```ts
  import { createAgent, resolveProvider } from '@loushy/build-ai-agent';
  const agent = createAgent({
    prompt: 'You are a helpful customer support assistant.',
    provider: resolveProvider('openai/gpt-4o-mini'),           // reads OPENAI_API_KEY
  });
  const result = await agent.send('Hello!');
  console.log(result.text);
  ```
  That is short, but wrong at runtime in two ways. (a) It sends `gpt-4`, not `gpt-4o-mini` (headline 1). (b) The root import eagerly loads **all** provider SDKs, so install needs `@ai-sdk/openai`, `@ai-sdk/anthropic` and `ollama-ai-provider` even for one (a documented "current limitation"; `package.json` `sideEffects` lists `providers/index`).
- **Type inference:** weak. `createAgent({ tools })` takes `Record<string, ToolDescriptor>` where `tool: AITool` erases generics. `ExecutionResult.toolCalls[].function.arguments` is a JSON **string** (OpenAI wire shape), not parsed or typed. There is no typed structured output, and `needsApproval(args: any)`.
- **Errors:** a decent hierarchy exists (`SDKError`, `ToolExecutionError`, `LLMProviderError`, `RateLimitError`, `TimeoutError`, ...) and `CompactedLLMProviderError` carries `category` and `retryAfterMs`. But the executor mostly throws plain `Error`s (for example "requires approval but no approvalStore"), and `ToolExecutionError` and `AgentExecutionError` are not raised by the loop. Messages for missing config are good (`createAgent: 'provider' is required. Example: ...`).
- **Docs:** README plus 7 doc files; `docs-links.test.ts` and `scripts/verify-docs-snippets.ts` (runs the quick-start snippets against a packed build, which is good practice). Doc errors found: `resumeAfterApproval` arg order (README), the `FlowBuilder` `addNode/addEdge` example, the MCP deep-import path, "hooks can mutate results", a stale roadmap item (Cloudflare real providers), `npm install` of an unpublished package, and a resume example that implies new input is accepted. A TypeDoc scaffold exists (`typedoc.json`). `CHANGELOG.md` is 25 lines with two entries and no LOU-* history.
- **Examples:** 6 small examples (support-bot, research-assistant, workflow-router, doc-qa, slack-notifier, tracing) plus the flagship `ops-pipeline`, all defaulting to the mock provider. They run offline, but none exercises a real provider, multi-turn tools or streaming. `ops-pipeline` is thoroughly tested.
- **Package exports:** dual ESM/CJS via tsup, `splitting: false` (each entry bundles its own copy of shared code, so `./core`, `./tools`, `./flows` and `./hooks` bundles likely duplicate modules; `instanceof` across subpaths, for example two `HookRegistry` or `ToolRegistry` classes, is a risk), `treeshake: true`, a `sideEffects` allow-list. Subpaths: `.`, `core`, `tools`, `flows`, `mcp`, `types`, `testing`, `otel`, `hooks`, `triggers`. Missing: `./providers`, `./evals`, `./security`, `./execution`, `./spec`, `./deploy`, and `./data` (a tsup entry but not in `exports`). The root re-exports everything, including `dockerode`, `undici`, `yaml` and Node-only fs code, so it is **not edge-safe** and heavy to import.
- **Peer deps:** `ai ^4.3.19`. The npm `latest` dist-tag is **7.0.126**, with v5 and v6 also released, so the SDK is 3 majors behind. `@ai-sdk/openai ^0.0.42` and `@ai-sdk/anthropic ^0.0.42` are **pinned to one patch**, because caret on `0.0.x` means `>=0.0.42 <0.0.43`; the latest `@ai-sdk/openai` is 4.0.83. `ollama-ai-provider ^1.2.0` is a community package. `tsup` is listed as a peer dep. `zod ^3.25.76` (zod 4 is current). Users with any modern Vercel AI SDK app hit unresolvable peer conflicts. `ToolDescriptor.tool` is typed as the `ai` v4 `Tool` (uses `parameters`), so upgrading `ai` breaks every user tool definition.
- **Node versions:** `engines.node >=18` and the docs say "Node 18 or newer", but the hard dependency `undici ^8` (used by the `http` tool, imported from the root) requires Node `>=22.19`. CI runs Node 22 and its comment says Node 20 crashes. The truthful minimum is 22.19.
- **Type quality:** 164 occurrences of `any` in non-test `src/` (29 are `as any`). `npx eslint src` currently reports 0 errors and 421 warnings.

---

## 13. TODO / FIXME / placeholder / stub occurrences

Grep over `src`, `apps/agent-forge`, `packages/create-loushy-agent/src`, `bin` and `scripts`: the codebase has almost no TODO or FIXME markers; most gaps are documented in prose. Real hits:
- `apps/agent-forge/src/persistence/fsAgentStore.ts:22`: `TODO(LOU-N): wire this up behind the runtime control server`.
- `packages/create-loushy-agent/src/template.ts:56-57`: generated `// TODO: wire up the '<tool>' tool (needs credentials)`.
- `src/execution/guardrails.ts:111`: "Minimal placeholder shape" for `ProposedAction`.
- `src/flows/FlowExecutor.ts:629`: "In production, use a safe expression evaluator" (above `eval`).
- `src/templates/TemplateManager.ts:38`: "A very naive approach" (`if` conditions).
- `src/providers/*Provider.ts` (8 sites): "This is just a placeholder, actual execution happens in AgentExecutor" (an intentional no-op `execute`).
- `src/cli/build.ts:47-69`: test-only `'stub'` deployment adapter registered at CLI startup.
- `src/deploy/runtime.worker.ts:27`: OpenRouter and Ollama "remain node-server/docker-only for now".
- `apps/agent-forge/server/runRegistry.ts:295` and `:494`: "Known limitation" notes (restart edge case, stopped mid-flight).
- Declared but not implemented or not wired: `ExecuteOptions.streaming`; the `'text-delta'` event; `LLMProviderConfig.maxRetries` and `timeout`; `spec.policy.*` and `spec.triggers`; `ToolDescriptor.injectStreamingController`; `MemoryManager` and `ContextBuilder` integration; `src/execution/retry.ts`; `src/security/quotas.ts` (SaaS leftover); `src/flows/converters.ts` (targets the absent `flows-ai`).

## 14. `docs/eslint-baseline-followup.md` summary

A 277-line tracker created by LOU-B1 that lists pre-existing lint violations intentionally left unfixed when the ESLint flat config was introduced. The header says "Total violations: 271" (the file lists 251 `no-explicit-any` entries, 19 `no-unused-vars` entries and one other). Each entry is `path:line [rule] message`. Biggest offenders: `src/flows/FlowExecutor.ts` (about 50 `any`s), `src/tools/built-in/jira.ts` (22), `github.ts` (20), `src/data/models.ts` (about 20), `OpenRouterProvider.ts` (13), `OllamaProvider.ts` (11), `OpenAIProvider.ts` (10), `flows/inputs.ts` (8), `types/flow.ts` and `types/agent.ts` (7 each). `eslint.config.mjs` downgrades `no-explicit-any`, `no-unused-vars` and `ban-ts-comment` to `warn` so CI's lint step does not stay red, with a comment to ratchet back to `error` once the baseline is cleared. Current reality: **0 errors and 421 warnings**. The doc is stale, and the count has grown by about 150 since the baseline. CI has no warning budget (`--max-warnings`), so nothing stops further growth.

---

## 15. Capability matrix

| Area | Status | Top weakness |
|---|---|---|
| Run loop | partial | No abort, streaming, structured output or multimodal; model name ignored (`gpt-4`) |
| Tools | partial | No arg validation; tied to `ai` v4 `tool()`; sequential only |
| HITL approvals | real | Mid-batch approval corrupts transcript; no edit-args; README arg-order bug |
| MCP | partial | Client-only; `jsonSchemaToZod` throws on `anyOf`/`$ref` and fails the whole server |
| Providers | partial | Tool turns dropped on OpenAI/Anthropic/Ollama; no fallback, retry config or cost |
| Memory / sessions | stub | `MemoryManager`/`ContextBuilder` unwired; no compaction or token counting; no DB adapters |
| Checkpoints | real (narrow) | Saved only after tool results; resumed run drops new input |
| Delegation | partial | Child loses hooks/tracing/approvals; no handoff or supervisor |
| Flows | partial | Types vs executor mismatch; `eval()`; README API fictional |
| Hooks | real (limited) | Can only throw to abort run; cannot deny a call or alter results |
| Guardrails | partial | Diff-only patch gates; no input/output guardrails; spec `policy` ignored |
| Sandbox | real | Opt-in only; "SubprocessSandbox" is Docker; heavy dockerode dependency |
| Skills | missing | No loader or registry |
| Templates / agent types | partial / stub | Naive `if`; agent types are inert donor residue |
| Spec | partial | Only name/prompt/provider/tools honoured; no maxSteps/mcp/policy |
| Triggers | partial | Interval-only cron; no webhook auth; Slack adapter is a passthrough |
| Deploy | partial | Single-turn `/chat`; no streaming or auth; Worker has 2 tools |
| Evals | partial | Single score, no datasets or regression store; vitest-only |
| Test utils | partial | `/testing` is repo mocks only; mock hides the tool-serialization bug |
| Observability | partial | Not OTel GenAI conventions; flows untraced; child agents unlinked |
| CLI | partial | 3 commands; dev chat stateless; no init/run/eval |
| Scaffolder | partial | Needs a sibling SDK checkout; SDK not on npm |
| Agent Forge | real | Router graphs lose approvals/hooks/checkpoints; local single-user |
| DX / packaging | partial | Peer deps 3 majors stale; Node engines wrong; root import eager and heavy |

## 16. Top 15 gaps, ranked by impact

1. **Model selection bug.** The executor ignores `provider.defaultModel` and the spec model, and sends `gpt-4` (`AgentExecutor.ts:407`).
2. **Assistant tool-call turns dropped** on OpenAI, Anthropic and Ollama (`convertMessages`), so real multi-step tool use fails.
3. **No streaming** through the executor (`text-delta` never emitted). This is table-stakes UX.
4. **No cancellation** (`AbortSignal` through the executor, provider and tools).
5. **Stale peer dependencies.** `ai` v4 and `@ai-sdk/*` 0.0.42 are pinned to one patch, and `ToolDescriptor` is tied to the v4 `tool()`. This needs a migration to `ai` v5+ or a provider-agnostic tool definition.
6. **Tool argument validation and parallel tool calls.** Validate with the zod schema, return parse errors to the model, run independent calls concurrently, and pass a real execution context (toolCallId, abortSignal).
7. **Structured output and multimodal input** (`Message.content` is string only).
8. **Memory and session layer unwired.** No thread persistence, no context-window management (token counting, trimming, summarization, compaction), no DB-backed stores.
9. **`eval()` in `FlowExecutor`** (security), plus the flow type/executor mismatch. Fix it, or deprecate flows in favor of the executor.
10. **Hook and guardrail model.** Add deny/skip/replace outcomes, input and output guardrails with tripwires, and honour `spec.policy`. Delegated sub-agents should inherit hooks and tracing.
11. **Provider resilience and accounting.** Wire `maxRetries` and `timeout`, add a fallback chain and routing, a cost table, cache and reasoning token counts, and budget limits.
12. **MCP robustness.** Handle `anyOf`/`$ref`/nullable schemas, isolate per-tool failures, handle `isError`, add a transport helper with lifecycle, resources and prompts, and an MCP server mode.
13. **Packaging truth.** Publish to npm or fix the docs; correct `engines` to Node >=22.19; make provider imports lazy (per-provider subpaths) and remove the eager root import; fix the `splitting: false` duplicate-class risk; add the missing subpaths.
14. **Durable execution depth.** Checkpoint after LLM turns, append new input on resume, fix mid-batch approval, add locking and idempotency, and provide production stores beyond local file and Cloudflare KV.
15. **Testing and eval ergonomics, and docs accuracy.** Add a scripted mock provider (with tool turns), real-provider contract tests, dataset-based evals and OTel GenAI conventions. Fix the README errors (resume arg order, `FlowBuilder`, MCP path). Clear the 421 lint warnings and restore `error` severity.

Honorable mentions: SKILL.md-style skills, handoff and supervisor patterns, webhook auth and signature verification, cron expressions, a `loushy init|run|chat|eval` CLI, and a stateful `loushy dev` chat with streaming.
