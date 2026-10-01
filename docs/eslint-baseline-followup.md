# ESLint Baseline Follow-up

The ESLint flat config (introduced in LOU-B1) originally surfaced 271 pre-existing violations. They have since been fixed or downgraded; `npm run lint` (`eslint src`) now reports **0 errors and 428 warnings**. Warnings are tolerated for now: do not add new ones, and burn these down incrementally.

Last refreshed: LOU-U5. Regenerate with `npx eslint src -f json` and group by `ruleId` / directory.

## By rule

| Rule | Warnings |
| --- | ---: |
| `@typescript-eslint/no-explicit-any` | 395 |
| `@typescript-eslint/no-unused-vars` | 22 |
| unused `eslint-disable` directives (no rule id) | 10 |
| `@typescript-eslint/ban-ts-comment` | 1 |

## By directory (under `src/`)

| Directory | Warnings |
| --- | ---: |
| `execution` | 123 |
| `flows` | 102 |
| `tools/built-in` | 54 |
| `data` | 28 |
| `providers` | 20 |
| `utils` | 19 |
| `types` | 18 |
| `templates` | 17 |
| `cli` | 10 |
| `tools/mcp` | 9 |
| `storage` | 8 |
| `core` | 6 |
| `deploy` (+ `deploy/adapters`) | 6 |
| `evals`, `security` | 3 each |
| `agent-types`, root | 1 each |

Most of the work is replacing `any` in `execution/` and `flows/` (mainly `FlowExecutor` node handling and the executor option plumbing) with real types.
