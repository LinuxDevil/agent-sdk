# Schedules

A **schedule** runs the agent on a cron expression, with nobody asking: a
morning summary, a nightly cleanup. `defineSchedule()` declares one, an
[agent directory](agent-directories.md) picks them up from `schedules/`, and
`startSchedules()` (or the node server) runs them in process.

## Define a schedule

Give a cron expression and exactly one of `prompt` (text sent to the agent as a
new turn) or `run` (your own function).

```ts
import { createAgent, createMockProvider, defineSchedule, startSchedules } from '@loushy/build-ai-agent';

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
  `prompt` and `run`, throws `LOUSHY_SCHEDULE_INVALID` from `defineSchedule()`,
  not at the first fire. See [Errors](errors.md#loushy_schedule_invalid).
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
import { createAgent, resolveAgentDir, startSchedules } from '@loushy/build-ai-agent';

const { config, schedules } = await resolveAgentDir('./my-agent');
const agent = createAgent(config);
const running = startSchedules(agent, schedules);
```

## On the node server

`createDeployedServer(agent, { schedules })` (the server of the `node-server`
and `docker` targets) starts the schedules when it listens and stops them when it
closes. The Cloudflare Worker target does not run schedules yet.
