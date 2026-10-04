import { defineSchedule } from '@lousho/build-ai-agent';

export default defineSchedule({
  cron: '0 9 * * MON',
  prompt: 'Write the report.',
});
