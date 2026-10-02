# Schedules

A **schedule** runs the agent on a cron expression, with nobody asking: a
morning summary, a nightly cleanup. `defineSchedule()` declares one, an
[agent directory](agent-directories.md) picks them up from `schedules/`, and
`startSchedules()` (or the node server) runs them in process.

## Define a schedule

Give a cron expression and exactly one of `prompt` (text sent to the agent as a
new turn) or `run` (your own function).

```ts
import { createAgent, createMockProvider, defineSchedule, startSchedules } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You write reports.', provider: createMockProvider() });

const morning = defineSchedule({ cron: '0 9 * * MON-FRI', timezone: 'Europe/Paris', prompt: 'Summarise yesterday.' });
const cleanup = defineSchedule({
  name: 'cleanup',
  cron: '@daily',
  run: async ({ agent, firedAt }) => {
    await agent.send(`Clean up, as of ${firedAt.toISOString()}.`);
  },
});

const running = startSchedules(agent, [morning, cleanup]);
// later, on shutdown:
running.stop();
```

- `cron`: five fields (`minute hour day-of-month month day-of-week`) or
  `@hourly`, `@daily`, `@weekly`, `@monthly`; evaluated in `timezone` (an IANA
  name, default the machine's zone). An invalid expression, or both/neither of
  `prompt` and `run`, throws `LOUSHO_SCHEDULE_INVALID` from `defineSchedule()`,
  not at the first fire. See [Errors](errors.md#lousho_schedule_invalid).
- `run` receives `{ agent, firedAt, name }`.

`startSchedules(agent, schedules, { now?, setTimer?, onError? })` keeps one
timer per schedule. A run that throws goes to `onError` (default: `console.error`)
and never stops the other schedules. A schedule does not overlap itself: if the
previous fire is still running, the next one is skipped and reported to
`onError`. Fires missed while the process was suspended are skipped, not
replayed. `now` and `setTimer` are injectable so tests never sleep.

## In an agent directory

```text
my-agent/
  instructions.md
  schedules/
    daily-report.ts    # export default defineSchedule({ cron: '0 9 * * *', prompt: '...' })
    nightly.ts         # name defaults to the file name ("nightly") unless the schedule sets `name`
```

`resolveAgentDir()` returns them as `schedules` (and their names in
`manifest.schedules`); `loadAgentDir()` does not start them. A directory without
`schedules/` loads exactly as before.

```ts
import { createAgent, resolveAgentDir, startSchedules } from '@lousho/build-ai-agent';

const { config, schedules } = await resolveAgentDir('./my-agent');
const agent = createAgent(config);
const running = startSchedules(agent, schedules);
```

## On the node server

`createDeployedServer(agent, { schedules })` (the server of the `node-server`
and `docker` targets) starts the schedules when it listens and stops them when it
closes. `lousho build ./my-agent --target=node-server` (or `docker`) builds an
agent directory into such a server, so its `schedules/` run in the deployed
process ([Deployment](deployment.md#agent-directories)). A spec's cron
`triggers` (`{ type: 'cron', cron, input, name?, timezone? }`) run on these
targets too: `lousho build spec.yaml --target=node-server` converts them with the
same rules as the Worker and the built server starts them when it listens
(`timezone` is supported; an invalid trigger fails the build with
`LOUSHO_SCHEDULE_INVALID`). The model calls run in the server process, so the
provider's package must be installed where it runs. On Cloudflare Workers see
below.

## In `lousho dev`

`lousho dev ./my-agent` starts the directory's schedules, so a cron fires while
you develop, and a hot reload stops the old schedules before starting the new
ones. Starting is the default so that dev behaves like the deployed server;
because firing crons (and spending model calls) while you edit is often
unwanted, `--no-schedules` mounts the channels but starts no schedule.

## On Cloudflare Workers

A Worker has no long-lived process, so no timers: Cloudflare calls the Worker's
`scheduled()` handler once per cron expression listed under `[triggers] crons`
in `wrangler.toml`. The `cloudflare-worker` target generates both from the
`triggers` of the agent spec:

```yaml
triggers:
  - type: cron
    name: weekly-report      # optional, default cron-1, cron-2, ...
    cron: "0 9 * * MON"      # five fields, UTC
    input: Summarise last week.
```

`lousho build` writes the deduplicated expressions to `[triggers] crons` and the
Worker's `scheduled()` runs every trigger whose `cron` equals the invoked one as
an agent turn inside `ctx.waitUntil()`. Each trigger has its own session,
`schedule:<name>`, so its runs are inspectable in the KV session store when
`AGENT_CHECKPOINTS` is bound (`GET /chat/schedule:weekly-report`, URL-encoded).
A failing trigger is logged with `console.error` (name and error code) and never
stops the others, and `scheduled()` never throws.

Cloudflare's cron triggers differ from the in-process ones, so the build fails
with `LOUSHO_SCHEDULE_INVALID` naming the trigger instead of emitting a config
that deploys and never fires: expressions are UTC (no `timezone`), exactly five
fields (no seconds, no `@daily`), and the day-of-week must be `*` or names
(`MON-FRI`), because Cloudflare numbers days 1-7 from Sunday. The finest
granularity is one minute, and Cloudflare may start a run a few seconds late.

To wire your own Worker entry, see
[Cloudflare Worker](deployment.md#cron-triggers-and-handlescheduled).
