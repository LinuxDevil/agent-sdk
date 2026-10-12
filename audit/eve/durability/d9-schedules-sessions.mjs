// D9a: REPORT.md B14 claims in-process prompt schedules run in a durable
// `schedule-<name>` session when the agent has a store. startSchedules() never
// passes a sessionId (startSchedules.ts startOne -> fireSchedule({ name, firedAt })).
// D9b: the Worker path (handleScheduled) DOES use one `schedule-<name>`
// session - for every fire forever, so each fire re-sends all previous
// fires' transcripts: input tokens grow linearly until context overflow.
import { createAgent, defineSchedule, startSchedules, memoryStore, handleScheduled } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';


// (a) in-process
{
  const store = memoryStore();
  const model = mockModel(['Report: all good.'], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: model, store });
  const schedule = defineSchedule({ name: 'daily-report', cron: '* * * * *', prompt: 'Run the daily report.' });
  let t = Date.parse('2026-10-09T09:00:30Z');
  const timers = [];
  const running = startSchedules(agent, [schedule], { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return () => {}; } });
  for (let i = 0; i < 2; i++) { const next = timers.shift(); t = next.at; next.fn(); await new Promise((r) => setTimeout(r, 20)); }
  await running.stop();
  const s = await store.sessions.load('schedule-daily-report');
  const cp = await store.checkpoints.load('schedule-daily-report');
  console.log(`[startSchedules] model calls: ${model.calls.length}; session 'schedule-daily-report':`, s ? `${s.length} msgs` : 'none', '| checkpoint:', cp ? cp.status : 'none');
  console.log(s || cp ? '  PASS' : '  FAIL: B14 "fixed" claim does not hold - in-process schedule turns are ephemeral, nothing in the store');
}
// (b) Worker scheduled() path
{
  const store = memoryStore();
  const model = mockModel([(r) => ({ text: 'Report: ' + 'x'.repeat(400), usage: { inputTokens: JSON.stringify(r.messages).length / 4 | 0, outputTokens: 100 } })], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: model, store });
  const schedule = defineSchedule({ name: 'daily-report', cron: '0 9 * * *', prompt: 'Run the daily report.' });
  const sizes = [];
  for (let day = 0; day < 30; day++) {
    await handleScheduled(agent, [schedule], { cron: '0 9 * * *', scheduledTime: Date.parse('2026-10-01T09:00:00Z') + day * 864e5 }, { waitUntil() {} });
    sizes.push(model.lastCall.messages.length);
  }
  console.log('[handleScheduled] messages sent to the model on day 1, 10, 30:', sizes[0], sizes[9], sizes[29]);
  console.log(sizes[29] > sizes[0] * 5 ? '  FAIL: each daily fire replays every previous report (unbounded growth)' : '  PASS');
}
