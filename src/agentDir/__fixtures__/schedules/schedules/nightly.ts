import { defineSchedule } from '../../../../schedules/defineSchedule';

export default defineSchedule({
  name: 'cleanup',
  cron: '@daily',
  timezone: 'UTC',
  run: async ({ agent }) => {
    await agent.send('Clean up.');
  },
});
