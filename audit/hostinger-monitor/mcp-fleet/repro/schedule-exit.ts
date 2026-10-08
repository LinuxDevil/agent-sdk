// Does startSchedules() keep a Node process alive on its own?
import { createAgent, defineSchedule, startSchedules } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
const agent = createAgent({ provider: mockModel(['ok']), instructions: 'x' });
const t0 = Date.now();
process.on('exit', () => console.log(`process exited after ${Date.now() - t0}ms; schedule fired=${fired}`));
let fired = false;
startSchedules(agent, [defineSchedule({ name: 'every-minute', cron: '* * * * *', run: async () => { fired = true; } })]);
console.log('startSchedules() returned; nothing else keeps the event loop alive');
