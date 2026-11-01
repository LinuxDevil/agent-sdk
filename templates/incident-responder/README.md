# Incident responder

Turns each firing alert into a short incident summary with likely causes and next steps, and posts it to Slack.

## What it needs
- A model provider key (Anthropic by default).
- Secrets `SLACK_WEBHOOK_URL` (an incoming webhook for your incident channel) and `ALERT_WEBHOOK_SECRET`.

## How it starts
- Webhook: point your alerting tool at `/alerts`. Only alerts with `status: firing` start a run.
- Chat: paste an alert to try it.

## Before you turn it on
- Replace `[YOUR MONITORING TOOL]` in the instructions.
- It only reads. Any HTTP request other than GET waits for your approval.
