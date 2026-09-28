# slack-notifier

Turns a raw event description into a short, Slack-ready notification
message, built with `createAgent()`.

Runs against a free local mock provider by default - no API key needed.
Set `OPENAI_API_KEY` to run it against real OpenAI instead.

```bash
npx tsx examples/slack-notifier/index.ts
```
