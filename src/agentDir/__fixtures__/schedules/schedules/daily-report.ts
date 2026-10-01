import { defineSchedule } from '../../../../schedules/defineSchedule';

export default defineSchedule({ cron: '0 9 * * *', prompt: 'Write the daily report.' });
