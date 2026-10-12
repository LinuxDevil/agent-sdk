// D19: cron in America/New_York. '30 2 * * *' has no run on 2027-03-14 (spring-forward day); fall-back fires once (good).
import { parseCronExpression } from '@lousho/build-ai-agent/triggers';
const tz = 'America/New_York';
const show = (expr, from) => { const s = parseCronExpression(expr, tz); let t = new Date(from); const out = []; for (let i = 0; i < 3; i++) { t = s.nextRun(t); out.push(t.toISOString()); } console.log(expr, from, '->', out.join(' ')); };
show('30 2 * * *', '2027-03-13T12:00:00Z'); // spring forward 2027-03-14
show('30 1 * * *', '2026-10-31T12:00:00Z'); // fall back 2026-11-01
show('0 * * * *', '2026-11-01T04:30:00Z');
show('*/30 1 * * *', '2026-11-01T04:00:00Z');
show('0 0 29 2 *', '2026-01-01T00:00:00Z');
show('0 9 * * 7', '2026-10-09T00:00:00Z');
try { show('0 9 * * MON-FRI', '2026-10-09T00:00:00Z'); show('0 9 1-7 * MON', '2026-10-09T00:00:00Z'); } catch (e) { console.log(e.message); }
