# Support triage

Sorts each new support ticket by type and urgency and drafts a first reply for a person to send.

## What it needs
- A model provider key (Anthropic by default).

## How it starts
- Chat: paste a ticket into the test pane.
- Webhook: POST a ticket as JSON (`from`, `subject`, `body`) to `/support/tickets`.

## Before you turn it on
- Replace `[YOUR PRODUCT]` and `[YOUR TEAM NAME]` in the instructions.
- Replies are drafts. Nothing is sent to the customer.
