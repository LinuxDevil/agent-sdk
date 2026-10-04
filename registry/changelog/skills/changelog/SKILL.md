---
description: Write a changelog entry for a diff, a commit range or a pull request
---

# Writing a changelog entry

When asked to write a changelog entry for a diff, a commit range or a pull request:

1. Read the whole change first; do not summarize from the title alone. Check
   public API surface (exports, options, flags, error codes) for behaviour and
   type changes a user could notice, and ignore pure internals (renames,
   formatting, refactors with no effect).
2. Group what you found by kind, in this order: breaking changes, new features,
   fixes, internal changes. A change a user must act on is breaking; say what
   the migration is.
3. Write one bullet per user-visible change, imperative mood, past tense
   avoided ("add", "fix", "remove"). Start with what the user sees, not how it
   is implemented; name the option, flag, function or error code it touches.
4. Keep it one section under the release heading the repository uses. Match the
   existing file's heading and bullet style instead of inventing a new one.
5. Link the pull request or issue when one is known; do not invent numbers.

Skip anything with no user-visible effect; a correct short entry beats a long
one that lists every touched file.
