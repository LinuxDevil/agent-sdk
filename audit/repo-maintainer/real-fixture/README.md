# agent-sdk (checkout at PR head)

`@lousho/build-ai-agent` — a durable AI-agent SDK. `src/server/` hosts the
HTTP surface: `fetchRoutes.ts` routes requests, `requestGuard.ts` enforces
per-session ownership (a request may only stream into a session its
principal owns). PR diffs live at the workspace root as `pr-N.diff`.
