# Inbox triage

Labels each incoming email, remembers what needs a reply, and emails you a short digest every weekday morning.

## What it needs
- A model provider key (Anthropic by default).
- Secrets `RESEND_API_KEY` (to send the digest) and `INBOX_WEBHOOK_SECRET` (to accept forwarded mail).

## How it starts
- Webhook: forward each email as JSON (`from`, `subject`, `text`) to `/inbox/new`.
- Schedule: 08:00 UTC, Monday to Friday, it sends the digest.
- Chat: ask what is waiting.

## Before you turn it on
- Replace `[YOUR NAME]`, `[YOUR EMAIL]` and `assistant@your-domain.example`.
- Every email it sends waits for your approval in the Inbox.
