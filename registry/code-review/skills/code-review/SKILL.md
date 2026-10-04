---
description: Review a diff or changed files for bugs, style and missing tests
---

# Reviewing a diff

When asked to review a diff, a commit range or a pull request:

1. Read the full diff before judging any line; a change that looks wrong can be
   explained by another hunk. For every file, note what changed and why it might
   have been changed.
2. Look for, in this order:
   - **Correctness**: off-by-one errors, null/undefined paths, wrong condition
     polarity, error handling that swallows or loses failures, race conditions,
     resource leaks (unclosed handles, missing cleanup).
   - **Compatibility**: changed signatures, renamed or removed exports, altered
     error shapes, behaviour a caller could depend on.
   - **Security**: unsanitized input reaching a command, query or path; secrets
     logged or hard-coded; permissions widened without need.
   - **Style and fit**: does it match the file's existing conventions (naming,
     error style, comments); is anything dead or duplicated.
   - **Tests**: does the diff cover what it changes; which cases are missing.
3. Report findings as a list ordered by severity (blocker, should-fix, nit).
   Each finding names the file and line range, says what is wrong, and suggests
   the fix in one or two sentences. Do not list what is fine; end with a one-line
   verdict (approve, approve with comments, request changes).

If the diff is clean, say so plainly instead of inventing nits.
