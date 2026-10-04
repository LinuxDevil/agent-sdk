# ESLint Baseline Follow-up

The ESLint flat config (introduced in LOU-B1) originally surfaced 271 pre-existing violations, which were downgraded to warnings and burned down over time (433 warnings at the start of the roadmap loop, 345 before LOU-D16).

**LOU-D16 cleared the baseline.** `npm run lint` (`eslint src --max-warnings 0`) reports 0 errors and 0 warnings, and it fails on any new one:

- `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars` and `@typescript-eslint/ban-ts-comment` are `error`.
- `--max-warnings 0` keeps any warn-level rule (including ones a future `typescript-eslint` release adds to `recommended`) from accumulating.
- `no-unused-vars` ignores names that start with `_` (a parameter an interface requires but the implementation does not use).

## When a real type is not possible

Use a targeted `// eslint-disable-next-line <rule> -- <reason>` on the one line, never a file- or directory-wide disable, a rule turned off in the config or a new `ignores` entry. At LOU-D16 the source had one (`ExecutionEvent.toolResult.result`, `no-explicit-any`, kept for compatibility); it is gone now that the type was removed (wave 4), so there are none.

In tests, a value of the wrong type passed on purpose (to check runtime validation) gets `// @ts-expect-error -- <reason>`; a partial mock is cast to the type it stands in for (`as Partial<T> as T` when it lacks a required member).

## By rule, before LOU-D16

| Rule | Warnings |
| --- | ---: |
| `@typescript-eslint/no-explicit-any` | 313 |
| `@typescript-eslint/no-unused-vars` | 23 |
| unused `eslint-disable` directives (no rule id) | 8 |
| `@typescript-eslint/ban-ts-comment` | 1 |
| **Total** | **345** |
