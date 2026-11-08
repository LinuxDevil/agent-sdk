---
description: How to trace a failing test to the code that is really wrong, and what a fix must keep working
---
1. Start from the failing assertion. Write down the input, the expected value and the actual value.
2. Read the function the test calls. If it calls a helper in another file, read that helper too. The wrong line is often in the helper.
3. Before you name a helper as the root cause, `grep` for its name. For each caller, say whether it would still be right if the helper changed.
4. If every caller wants the new behaviour, the fix belongs in the helper. If one caller relies on the old behaviour, the fix belongs in the caller from the bug report.
5. Compare the code with each rule in `docs/CONVENTIONS.md`: a validation failure, a changed argument, or work started after a failure.
6. List the edge cases the bug report implies: empty input, zero, negative numbers, exact boundaries, falsy values, keys with special names, and an input left unchanged.
