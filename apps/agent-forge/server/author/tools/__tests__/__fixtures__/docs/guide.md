# Studio Guide

The guide explains the Studio workspace and its screens.

## Handoffs and context

A handoff moves the conversation from the current agent to another agent
in the same workspace, carrying the model's summary of what has happened
so far plus whatever context the caller attaches. The handoff input
filter decides which fields of the incoming request the target agent can
read, so a specialist never sees more than it needs. Filters are written
as small allow-lists per field name and they apply to both the request
body and the caller's attached context, which keeps the data flow
predictable when several agents cooperate on one conversation.

## Keyboard shortcuts

Save is Control-S. Run is Control-Enter.
