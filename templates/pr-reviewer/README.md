# Pull request reviewer

Reviews each new or updated pull request and posts one review comment after you approve it.

## What it needs
- A model provider key (Anthropic by default).
- Secrets `GITHUB_TOKEN` (a token that can read the repository and comment) and `GITHUB_WEBHOOK_SECRET`.

## How it starts
- Chat: ask it to review a pull request by number.
- GitHub: a webhook for pull request events, opened or updated.

## Before you turn it on
- Replace `your-org/your-repo` in the tool settings and the instructions.
- Every comment waits for your approval in the Inbox. The agent cannot push, merge or close.
