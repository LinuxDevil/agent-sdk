// D18: docs/schedules.md: "Each trigger has its own session, schedule-<name>,
// so its runs are inspectable in the KV session store (GET /chat/schedule-weekly-report)".
// handleScheduled runs agent.send(prompt, { sessionId }) - a checkpoint-keyed
// run, not an agent.session() transcript - so the session store stays empty
// and GET /chat/<id> shows nothing.
import { createAgent, defineSchedule, handleScheduled, memoryStore, createRouteHandler } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const store = memoryStore();
const agent = createAgent({ provider: mockModel(['Weekly report: all green.'], { onExhausted: 'repeat-last' }), store });
await handleScheduled(agent, [defineSchedule({ name: 'weekly-report', cron: '0 9 * * MON', prompt: 'Summarise last week.' })], { cron: '0 9 * * MON' }, { waitUntil() {} });
console.log('checkpoint schedule-weekly-report:', (await store.checkpoints.load('schedule-weekly-report'))?.status);
console.log('session store schedule-weekly-report:', JSON.stringify(await store.sessions.load('schedule-weekly-report')));
let routes;
try { routes = createRouteHandler(agent); } catch (e) { console.log('createRouteHandler:', e.message); }
if (routes) {
  const handler = routes.GET ?? routes;
  const res = await handler(new Request('http://x/api/agent/chat/schedule-weekly-report'));
  console.log('GET /chat/schedule-weekly-report ->', res.status, (await res.text()).slice(0, 200));
}
