---
description: A checklist for reviewing a bug fix, with the edge cases to try in your head for each kind of input
---
For each changed function, walk these inputs through the code and say what it returns:

- Numbers: 0, a negative number, a value exactly on a boundary, a value one past it, a fraction.
- Strings: empty, only spaces, leading and trailing spaces, punctuation, text that starts with a number.
- Arrays: empty, one item, a length that does not divide evenly, items with the same key.
- Objects: a key whose value is 0, `false`, `''` or `undefined`, a missing key, keys named `constructor` or `toString`, nested objects, arrays inside objects, `null`.
- Dates: the last day of a month, a leap year, a negative step.
- Async code: the first call fails, a later call fails, a slow first call.

Then check the conventions:

- Was any argument changed? Call the function and compare the argument before and after.
- Does invalid input throw `ValidationError` with `field` set to the parameter name?
- Does concurrent code start new work after a failure?
- `grep` for each changed export. Does every caller still get what its own test expects?
