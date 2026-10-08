// Offline (mock model, injected clock): what does a schedule do with a run that did not succeed, and does stop() wait?
import { createAgent, defineSchedule, defineTool, startSchedules } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

let now = Date.UTC(2026, 9, 8, 10, 0, 30);
const timers: Array<() => void> = [];
const clock = { now: () => now, setTimer: (fn: () => void) => (timers.push(fn), () => {}) };
const tick = async () => { now += 60_000; const fns = timers.splice(0); fns.forEach((f) => f()); await new Promise((r) => setTimeout(r, 100)); };

// 1. prompt schedule whose run pauses for approval -> is anybody told?
const risky = defineTool({ name: 'restart_vm', description: 'x', input: z.object({}), needsApproval: true, execute: async () => 'restarted' });
let runs1 = 0;
const a1 = createAgent({ onEvent: (e) => { if (e.type === 'run.done') { runs1++; console.log('   a1 run.done finishReason=', (e as any).finishReason); } }, provider: mockModel([{ toolCalls: [{ name: 'restart_vm', args: {} }] }, { text: 'done' }]), instructions: 'x', tools: [risky] });
const errors: string[] = [];
const s1 = startSchedules(a1, [defineSchedule({ name: 'prompt-sched', cron: '* * * * *', prompt: 'check fleet' })], { ...clock, onError: (e) => errors.push(String((e as Error).message)) });
await tick();
console.log('1) prompt schedule, run paused for approval -> onError calls:', errors.length, '| pending approvals left behind:', (await a1.approvals.list()).length, '| runs:', runs1);
s1.stop(); timers.length = 0;

// 2. prompt schedule with output schema that the model violates
const a2 = createAgent({ onEvent: (e) => { if (e.type === 'run.done') console.log('   a2 run.done finishReason=', (e as any).finishReason); }, provider: mockModel(['not json', 'still not json', 'nope']), instructions: 'x', output: z.object({ status: z.string() }) });
errors.length = 0;
const s2 = startSchedules(a2, [defineSchedule({ name: 'prompt-out', cron: '* * * * *', prompt: 'report' })], { ...clock, onError: (e) => errors.push(String(e)) });
await tick();
console.log('2) prompt schedule, output-invalid result -> onError calls:', errors.length);
s2.stop(); timers.length = 0;

// 3. stop() while a run is in flight
let finishedAfterStop = false;
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const s3 = startSchedules(a2, [defineSchedule({ name: 'slow', cron: '* * * * *', run: async () => { await gate; finishedAfterStop = true; } })], clock);
await tick();
const ret = s3.stop();
console.log('3) stop() returned', ret, '(not a promise) while run in flight; run still pending:', !finishedAfterStop);
release();
await new Promise((r) => setTimeout(r, 20));
console.log('   ...run finished after stop():', finishedAfterStop);
