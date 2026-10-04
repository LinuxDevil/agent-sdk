# ops-pipeline (LOU-J8)

An end-to-end "flagship pipeline" demo composing every LOU-J primitive:

1. **Monitor** (LOU-J4) - a `POST /webhook` listener that receives a Grafana/
   Datadog-shaped `ErrorSignal`, dedupes it by signature, and asks the
   monitor agent to triage it.
2. **Approval gate** (LOU-C, via the real `ApprovalGate`/`resumeAfterApproval`)
   - the monitor's delegation to the fixer agent is flagged
   `needsApproval: true`, so it always pauses for a human before the fixer
   agent ever runs.
3. **Slack "Fix it" button** (LOU-J5) - the pause posts a Slack alert with a
   "Fix it" button; clicking it (`POST /slack/interactions`) resumes the
   paused run through the REAL `resumeAfterApproval()`.
4. **Fixer** (LOU-J6) - once approved, the fixer agent diagnoses the error
   and produces a unified diff.
5. **PatchCheck-gated PR** (LOU-J7) - the diff is checked against the REAL
   `secretScanCheck` + a diff-size cap BEFORE a GitHub PR is even
   considered; a failure notifies Slack instead of ever calling GitHub.

By default this runs entirely against the `mocks/` implementations (mock
Slack API, mock GitHub API, and a deterministic scripted LLM provider), so
it needs **zero external network access** and zero API keys.

## Setup

1. Install dependencies (from the repo root):

   ```
   npm install
   ```

2. Copy the example env file (only needed if you want to point this at
   REAL Slack/GitHub/LLM providers instead of the mocks - the demo works
   with none of this set):

   ```
   cp examples/ops-pipeline/.env.example .env
   ```

3. Start the demo pipeline:

   ```
   npm run pipeline:demo
   ```

   This starts two local listeners (both bound to `127.0.0.1`):
   - `http://127.0.0.1:8787/webhook` - the monitor's error-signal intake
   - `http://127.0.0.1:8788/slack/interactions` - the Slack button callback

4. In a second terminal, POST a synthetic error at the running pipeline:

   ```
   npm run pipeline:demo:trigger
   ```

   Watch the first terminal's output - this triggers the monitor agent,
   which pauses for approval and posts a (mock) Slack alert with a "Fix
   it" button.

5. Simulate clicking "Fix it" (in the real integration this is a real
   Slack button click; here it's a plain POST simulating Slack's
   interaction callback - substitute the `approvalId` your mock Slack
   tool logged):

   ```
   curl -X POST http://127.0.0.1:8788/slack/interactions \
     -H 'Content-Type: application/json' \
     -d '{"type":"block_actions","actions":[{"action_id":"fix_it","value":"<approvalId>"}]}'
   ```

   This resumes the paused run, runs the fixer agent, and - if the
   patch check passes - creates a (mock) GitHub pull request.

## Files

- `monitor.ts` - LOU-J4: ErrorSignal type, dedup, `POST /webhook`.
- `fixer.ts` - LOU-J6: fixer agent, diff extraction, fixer-tool wiring.
- `guardedPr.ts` - LOU-J7: patch-check-gated PR creation.
- `demoProvider.ts` - a deterministic, zero-network scripted LLM provider
  used by the demo in place of a real model.
- `mocks/` - mock Grafana sender, mock Slack API, mock GitHub API (same
  call shapes as the real tools).
- `index.ts` - wires everything into one process (`npm run pipeline:demo`).

## Real credentials (optional)

Set these to run against real services instead of the mocks - none are
required for the default demo:

- `SLACK_WEBHOOK_URL` - real Slack Incoming Webhook (see
  `src/tools/built-in/slack.ts`)
- `SLACK_SIGNING_SECRET` - your Slack app's signing secret. When set,
  `POST /slack/interactions` verifies every request's `X-Slack-Signature`
  (via the SDK's `verifySlackSignature`) and answers 401 otherwise. Set it
  whenever the endpoint is reachable from the internet.
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` - real LLM provider (pass a real
  `LLMProvider` to `startOpsPipeline({ provider })` instead of the default
  `demoProvider`)
- A real GitHub token (`src/tools/built-in/github.ts`'s `createGitHubTools`)
  passed as `githubCreatePrTool` to `startOpsPipeline()`
