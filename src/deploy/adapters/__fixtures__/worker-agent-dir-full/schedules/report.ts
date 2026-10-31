import { defineSchedule } from 'lousho';

export default defineSchedule({
  cron: '0 9 * * MON',
  prompt: 'Write the report.',
});
