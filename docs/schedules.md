# Schedules

A **schedule** runs the agent on a cron expression, with nobody asking: a
morning summary, a nightly cleanup. `defineSchedule()` declares one, an
[agent directory](agent-directories.md) picks them up from `schedules/`, and
`startSchedules()` (or the node server) runs them in process. Schedules replace
the deprecated `CronTriggerAdapter` (see [Triggers](triggers.md#cron-schedules)).

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
// later, on shutdown (resolves once the runs in flight have finished):
await running.stop();
```

- `cron`: five fields (`minute hour day-of-month month day-of-week`) or
  `@hourly`, `@daily`, `@weekly`, `@monthly`; evaluated in `timezone` (an IANA
  name, default the machine's zone). An invalid expression, or both/neither of
  `prompt` and `run`, throws `LOUSHO_SCHEDULE_INVALID` from `defineSchedule()`,
  not at the first fire. See [Errors](errors.md#lousho_schedule_invalid).
- `run` receives `{ agent, firedAt, name }`.

`startSchedules(agent, schedules, { now?, setTimer?, onError?, keepAlive? })` keeps one
timer per schedule. A run that throws goes to `onError` (default: `console.error`)
and never stops the other schedules. A prompt schedule's turn that ends with any
`finishReason` other than `'stop'` is a failed run too: `onError` receives a
`LOUSHO_SCHEDULE_RUN_INCOMPLETE` error naming the reason, for example
`'awaiting-approval'` (with the pending approval's id, which stays pending until
you resolve it with `agent.approvals.resolve()`), `'output-invalid'` or
`'max-steps'`. A schedule does not overlap itself: if the
previous fire is still running, the next one is skipped and reported to
`onError`. Fires missed while the process was suspended are skipped, not
replayed. `now` and `setTimer` are injectable so tests never sleep.

`stop()` clears the timers, so nothing fires again, and returns a promise that
resolves once the runs already in flight have finished. You can call it without
`await`.

The timers are unref'd: they never keep a process alive on their own, so a
server or a test exits normally. A script that does nothing but run schedules
would therefore exit straight away; pass `keepAlive: true` for that:

```ts
import { createAgent, createMockProvider, defineSchedule, startSchedules } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You write reports.', provider: createMockProvider() });
const running = startSchedules(agent, [defineSchedule({ cron: '@hourly', prompt: 'Check the queue.' })], { keepAlive: true });
process.once('SIGTERM', () => void running.stop().then(() => agent.close()));
```

## Run a schedule now

`fireSchedule(agent, schedule, { name?, firedAt?, sessionId? })` fires a schedule
once, immediately, exactly as a tick would: it calls `run`, or sends `prompt`
as a turn (in `sessionId` when given, which needs an agent with a store; by
default each fire runs in its own session, `schedule-<name>-<fire time>`, when the agent has
a store, and `schedule-<name>` when the schedule sets `sharedSession: true`). It
rejects when the run fails, including with `LOUSHO_SCHEDULE_RUN_INCOMPLETE`, so
it suits an ops "run now" and tests.

```ts
import { createAgent, createMockProvider, defineSchedule, fireSchedule } from '@lousho/build-ai-agent';

const agent = createAgent({ instructions: 'You write reports.', provider: createMockProvider() });
const report = defineSchedule({ name: 'report', cron: '0 9 * * *', prompt: 'Run the daily report.' });
await fireSchedule(agent, report);
```

## Prompt schedules and sessions

A prompt schedule's fire is an `agent.send(prompt, { sessionId })` run, not an
`agent.session({ id })` turn (see
[Two kinds of conversation id](./sessions.md#two-kinds-of-conversation-id)). Its
id is `schedule-<name>-<fire time>` (`schedule-<name>` with
`sharedSession: true`), and its conversation is kept in the agent's
`store.checkpoints`, as a finished checkpoint, when the agent has one; without
a checkpoint store the fire runs without an id and keeps nothing.
`GET /chat/<id>` and `agent.session({ id }).load()` read the session store, so
they show an empty transcript for a schedule id. Read a fire's report from the
checkpoint store instead, or continue it with `agent.fork(id)`:

```ts
import { createAgent, createMockProvider, defineSchedule, fireSchedule, memoryStore } from '@lousho/build-ai-agent';

const store = memoryStore();
const agent = createAgent({ instructions: 'You write reports.', provider: createMockProvider(), store });
const firedAt = new Date('2026-10-05T09:00:00Z');
await fireSchedule(agent, defineSchedule({ name: 'weekly-report', cron: '0 9 * * MON', prompt: 'Summarise last week.' }), { firedAt });

const fire = await store.checkpoints.load('schedule-weekly-report-2026-10-05T090000Z');
console.log(fire?.status, fire?.messages.at(-1)?.content); // 'finished', the report
```

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

`createDeployedServer(agent, { schedules })` (the internal helper behind the
server that `lousho build` emits for the `node-server`
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
`triggers` of the agent spec — and, for an agent directory, from its
`schedules/` files, which follow the same rules below:

```yaml
triggers:
  - type: cron
    name: weekly-report      # optional, default cron-1, cron-2, ...
    cron: "0 9 * * MON"      # five fields, UTC
    input: Summarise last week.
```

`lousho build` writes the deduplicated expressions to `[triggers] crons` and the
Worker's `scheduled()` runs every trigger whose `cron` equals the invoked one as
an agent turn inside `ctx.waitUntil()`. Each fire has its own session,
`schedule-<name>-<fire time>` (for example `schedule-weekly-report-2026-10-05T090000Z`),
so a daily job does not re-send every earlier report, and its run can be read
back from the checkpoints in KV when `AGENT_CHECKPOINTS` is bound (see
[Prompt schedules and sessions](#prompt-schedules-and-sessions); not
`GET /chat/<id>`). Set `sharedSession: true` on a `defineSchedule()` prompt
schedule to keep one `schedule-<name>` session instead; its conversation then
grows with every fire. The run
happens inside `ctx.waitUntil()`, past the request's lifetime, so give the
agent a store (`KVStore` on `AGENT_CHECKPOINTS`) — an in-memory one keeps the
schedule sessions only until the isolate is recycled. A failing
trigger is logged with `console.error` (name and error code) and never
stops the others, and `scheduled()` never throws. A turn that ends with a
`finishReason` other than `'stop'` is logged the same way, as
`LOUSHO_SCHEDULE_RUN_INCOMPLETE`.

Cloudflare's cron triggers differ from the in-process ones, so the build fails
with `LOUSHO_SCHEDULE_INVALID` naming the trigger instead of emitting a config
that deploys and never fires: expressions are UTC (no `timezone`), exactly five
fields (no seconds, no `@daily`), and the day-of-week must be `*` or names
(`MON-FRI`), because Cloudflare numbers days 1-7 from Sunday. The finest
granularity is one minute, and Cloudflare may start a run a few seconds late.

To wire your own Worker entry, see
[Cloudflare Workers](cloudflare-workers.md#scheduled-runs).
