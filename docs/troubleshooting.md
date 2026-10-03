# Troubleshooting

This page starts from what you see and points to the cause, the fix and the page
that explains it. First run `npx lousho doctor` ([what it checks](./installation.md#troubleshooting-lousho-doctor)),
then, if you have an error code (`LOUSHO_...`), look it up in [Errors](./errors.md).

## Setup

### "No model configured"

- **Cause:** `createAgent()` got no `model` or `provider` and found nothing in the
environment (`LOUSHO_CONFIG_MISSING_PROVIDER`).
- **Fix:** pass `model: 'openai/gpt-4o-mini'` (any `<provider>/<model>`), or set `LOUSHO_MODEL` or a provider key such as `OPENAI_API_KEY`.
- **More:** [Providers](./providers.md), [the error](./errors.md#lousho_config_missing_provider).

### "The API key is not set"

- **Cause:** the provider's key variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) is not in the environment of the process that runs the agent (`LOUSHO_PROVIDER_MISSING_API_KEY`).
- **Fix:** set it, or pass a configured provider instance. `npx lousho doctor` prints `set` or `not set` for each key, never the value. The `vendor/` model prefix chooses the provider; with OpenRouter use `openrouter/<vendor>/<model>` (e.g. `openrouter/openai/gpt-4o-mini`) — `model: 'openai/gpt-4o-mini'` needs `OPENAI_API_KEY` even when only `OPENROUTER_API_KEY` is set.
- **More:** [the error](./errors.md#lousho_provider_missing_api_key).

### "Cannot find package `@ai-sdk/openai`" or "install the optional peer"

- **Cause:** each provider is backed by an optional package that is loaded on first use, in the major that pairs with your `ai` major (`LOUSHO_PEER_MISSING`). The same error covers the other optional peers, such as `dockerode` and `@modelcontextprotocol/sdk`.
- **Fix:** run the `npm install` command in the message (it is also on `error.installCommand`), or look up your `ai` major in the pairing table.
- **More:** [Provider packages](./installation.md#provider-packages), [Optional peers](./installation.md#optional-peers), [the error](./errors.md#lousho_peer_missing).

### "`ai` 5 is installed"

- **Cause:** `ai` 5 is not supported. The SDK takes `ai` `^4.3.19`, `^6.0.0` or `^7.0.0`.
- **Fix:** install one of those majors together with the provider package row that pairs with it.
- **More:** [Install the package](./installation.md#install-the-package).

### "Top-level await is only available in ES modules"

- **Cause:** the quick start uses top-level `await`, so the file must be an ES module.
- **Fix:** name the file `.mts`, or set `"type": "module"` in `package.json`.
- **More:** [Quickstart in the README](../README.md#quickstart).

### The Node version is too old

- **Cause:** the SDK needs Node.js 22.19 or newer (`engines.node`).
- **Fix:** upgrade Node. `npx lousho doctor` compares your version with the requirement.
- **More:** [Requirements](./installation.md#requirements).

### Ollama and zod versions disagree

- **Cause:** `ollama-ai-provider-v2` (the Ollama package for `ai` 6 and 7) declares zod 4 as a peer. Zod 3 does not satisfy it.
- **Fix:** use zod 4 with `ai` 6 or 7, or use `ai@^4.3.19` with `ollama-ai-provider@^1.2.0`.
- **More:** [Provider packages](./installation.md#provider-packages).

## Runs that end without an answer

### `send()` returned but `text` is empty

- **Cause:** a run that stops early resolves; it does not throw. `result.finishReason` says why. These are the ones that leave `text` empty or partial:

  - `'awaiting-approval'`: a tool call needs a human. Resolve it (next entry). [Approvals](./approvals.md).
  - `'max-steps'`: the `maxSteps` budget (default 10) ran out while the model still wanted to continue. Raise `maxSteps`, or simplify the task. [Finish reasons](./runs.md#finish-reasons).
  - `'budget-exceeded'`: a `limits` budget such as `maxTokens` or `maxCostUsd` tripped; `result.budget` says which. Raise the limit. [Budgets](./configuration.md#budgets).
  - `'guardrail'`: an input, output or tool guardrail blocked the run; `result.guardrail` says which. [Guardrails](./guardrails.md#input-and-output-guardrails).
  - `'output-invalid'`: the reply did not match the `output` schema even after the repair step. [Structured output](./structured-output.md).

- **Fix:** check `result.finishReason` before reading `result.text`.

### The run seems stuck on a tool

- **Cause:** an approval is pending. A paused `send()` resolves with `finishReason: 'awaiting-approval'` and an `approvalId`; nothing runs until someone decides.
- **Fix:** list the pending calls with `agent.approvals.list()`, then `agent.approvals.resolve({ id, approved })`.
- **More:** [`createAgent()` agents](./approvals.md#createagent-agents).

### `LOUSHO_SESSION_AWAITING_APPROVAL` or `LOUSHO_SESSION_BUSY`

- **Cause:** a session paused on an approval cannot take new input (`LOUSHO_SESSION_AWAITING_APPROVAL`); `session.compact()` or `session.clear()` was called while a turn was running or queued (`LOUSHO_SESSION_BUSY`).
- **Fix:** resolve the approval, then send again; or await the turn's `send()` (or abort it), then call again.
- **More:** [awaiting approval](./errors.md#lousho_session_awaiting_approval), [busy](./errors.md#lousho_session_busy).

## Tools

### The model never calls my tool

- **Cause:** the model decides from the tool's `description` and input schema, so a vague description or unclear fields leave it nothing to go on. The `name` must match `^[a-zA-Z0-9_-]{1,64}$` (1-64 characters of letters, digits, `_` and `-`).
- **Fix:** say in the `description` what the tool does and when to use it, and `.describe()` each input field.
- **More:** [`defineTool()` options](./tools.md#definetool-options).

### My tool throws and the run goes on

- **Cause:** this is by design. A tool that throws gives the model an error result (`{ error, toolName, message, kind }`) and the run continues, so the model can react.
- **Fix:** if an error must stop the run, throw an error that extends `PropagatingToolError`; that one rejects the run instead.
- **More:** [Tool errors](./tools.md#errors).

### `LOUSHO_TOOL_ARGS_INVALID`

- **Cause:** the model sent arguments that do not match the tool's input schema. Inside a run it gets the issues back as a result and can retry, so a run seldom ends on it.
- **Fix:** if the model keeps getting a field wrong, make its `.describe()` text clearer. If you called the tool yourself, fix the arguments named in the message.
- **More:** [the error](./errors.md#lousho_tool_args_invalid).

## Providers and models

### Rate limits and flaky calls

- **Cause:** the provider throttled the call (`LOUSHO_PROVIDER_RATE_LIMITED`) or failed transiently.
- **Fix:** `createAgent()` already retries a failed call twice — but only for a model given as a `provider/model` string or resolved from the environment; a `provider` instance you pass is retried only when you set `retry`. Raise it with `retry: { maxRetries: 3 }`, and set `fallbackModels` to move on to the next model when the call still fails.
- **More:** [Retries and fallback models](./providers.md#retries-and-fallback-models), [the error](./errors.md#lousho_provider_rate_limited).

### The model does not read my files

- **Cause:** a built-in provider sends a file part only for the media types it supports on your `ai` major: on `ai` 6/7 `application/pdf` reaches `openai`, `anthropic` (which also sends `text/plain`) and `openrouter`. Every other media type — and every file on `ai` 4 or `ollama` — is sent as a text note (`[file report.pdf (application/pdf) not sent]`) and the provider warns once. Images are sent.
- **Fix:** use `ai` 6 or 7 with a media type the provider sends (see the table), put the file's text in the message, or use a provider subclass whose model takes files.
- **More:** [Multimodal input](./providers.md#multimodal-input).

### I do not see the model's reasoning

- **Cause:** reasoning is reported separately from the answer, as `reasoning.*` events in `agent.stream()` and as `result.reasoning`; it is not in `result.text`. Options are only sent to model families known to accept them, and `reasoning: 'none'` sends nothing.
- **Fix:** read `result.reasoning` or the `reasoning.delta` events; for a model outside the known families, pass `{ effort, force: true }`.
- **More:** [Reasoning](./reasoning.md).

## Sandbox, MCP and deployment

### Docker sandbox: "egress is unsupported"

- **Cause:** a `SubprocessSandbox` with `network: { allow }` and a `broker` needs the broker to be the container's only way out. Docker Desktop, rootless Docker, a daemon on another machine and an Engine older than 25.0.5 cannot do that, so no container starts (`LOUSHO_SANDBOX_EGRESS_UNSUPPORTED`). This is refused on purpose rather than granting open egress.
- **Fix:** run the agent on the Linux host of a Docker Engine 25.0.5 or later, or use `network: 'none'`.
- **More:** [Sandboxed shell](./workspace-tools.md#sandboxed-shell-sandboxshell), [the error](./errors.md#lousho_sandbox_egress_unsupported).

### An MCP server's tools do not appear

- **Cause:** the servers connect on `await agent.ready()` or on the first `send()` / `stream()`, and a server that cannot connect fails that call. Each tool is named `<server>__<tool>` (for example `docs__search`), so look for that name, not the server's own.
- **Fix:** `await agent.ready()` to see the connection error. With `connectMcp()`, check `status()`, which maps each server to `'idle'`, `'connected'`, `'failed'` or `'needs-auth'` (an `oauth` server whose app still needs to sign in — see `agent.oauth.mcpSignInUrl()`); `onError: 'skip'` leaves a failing server out and warns through `logger`. MCP needs the optional peer `@modelcontextprotocol/sdk`.
- **More:** [Use MCP servers in an agent](./mcp.md#use-mcp-servers-in-an-agent).

### My Worker build rejects the provider or tool

- **Cause:** the `cloudflare-worker` target supports the `mock`, `openai`, `anthropic` and `openrouter` providers, and the `current-date`, `day-name` and `http` tools (`http` reaches only the hosts listed in the `LOUSHO_HTTP_ALLOW` binding). `ollama` and the `web-fetch` tool are not supported there, and `lousho build` fails with an error naming the one it rejected.
- **Fix:** use another provider or tool, or build for the `node-server` or `docker` target.
- **More:** [Cloudflare Workers](./cloudflare-workers.md#providers-and-tools).

## Getting help

Open an issue at <https://github.com/LinuxDevil/agent-sdk/issues>. Include:

- the output of `npx lousho doctor --json`,
- the error code (`LOUSHO_...`) and the full message,
- the SDK version (`npm ls @lousho/build-ai-agent`) and your `ai` version.

Never paste an API key.
