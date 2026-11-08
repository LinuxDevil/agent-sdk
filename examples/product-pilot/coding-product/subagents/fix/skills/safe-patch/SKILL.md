---
description: Patterns for a small fix that follows the project conventions and keeps other callers working
---
- Sorting or reversing an array argument: copy it first with `[...items]`.
- Adding a field to objects you were given: return new objects with `{ ...item, field }`.
- Changing a `Date` you were given: work on `new Date(date.getTime())`.
- Invalid input: `throw new ValidationError('<parameter name>', '<message>')`, with `ValidationError` from `src/errors.js`. The field is the name of the parameter that was invalid.
- A shared helper that other callers rely on: change the caller from the bug report, not the helper.
- Keys from user data: use a `Map` or `Object.hasOwn`, never a truthiness check on a plain object.
- After you write a file, read it back and run the tests.
