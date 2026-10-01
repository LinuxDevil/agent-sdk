# eve reference agents (not compiled here)

Written against eve 0.69.0 (vercel/eve@682c7a6, 2026-10-01) from its docs and
`packages/eve/src`. eve is filesystem-first: an agent is an `agent/` directory
served by `eve dev` / `eve start`; a program talks to it with `eve/client`.
So each agent here is a directory (`<agent>/agent/**`) plus, where a program is
needed, a `<agent>.ts` client script. These files cannot be type-checked in
this repo (no `eve` install; it needs Node 24 and AI SDK 7).
