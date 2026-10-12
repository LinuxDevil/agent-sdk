/**
 * REPRO: aborting a run while a signal-IGNORING tool executes hangs forever.
 *
 * The e5f5731b abort work raced provider calls against the signal
 * (generateStep.ts `abortable()`, "a provider that ignores it does not hold
 * an aborted run") but ToolBatch.run() still does
 * `await Promise.all(this.running)` (toolBatch.ts:147) with no signal race:
 * every STARTED call's `done` promise is awaited unconditionally. A tool
 * whose execute() never settles (ignoring ctx.abortSignal - permitted, the
 * signal is documented as cooperative, "so in-flight work can stop early")
 * keeps the run hanging after abort.
 *
 * Expected: send() resolves with finishReason 'aborted' (or rejects) soon
 *           after the signal fires - the same contract the provider path has.
 * Actual:   send() never settles.
 */
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { defineTool } from '../../../src/tools/defineTool';
import { mockModel } from '../../../src/testing/mockModel';

let toolSawAbort = false;

const slow = defineTool({
  name: 'slow_tool',
  description: 'a tool that never finishes and ignores the abort signal',
  input: z.object({}),
  execute: async (_args, ctx) => {
    // A cooperative tool would watch ctx.abortSignal; this one (like any
    // blocking syscall or careless user tool) does not.
    ctx.abortSignal?.addEventListener('abort', () => {
      toolSawAbort = true; // signal DID reach the tool context
    });
    return new Promise<string>(() => {}); // never settles
  },
});

const agent = createAgent({
  prompt: 'test',
  provider: mockModel([
    { toolCalls: [{ name: 'slow_tool', args: {} }] },
    { text: 'should never reach' },
  ]),
  tools: [slow],
});

const controller = new AbortController();
const started = Date.now();
let settled: string | undefined;
const run = agent.send('go', { signal: controller.signal }).then(
  (r) => (settled = `resolved finish=${r.finishReason} after ${Date.now() - started}ms`),
  (e) => (settled = `rejected ${e?.name ?? e} after ${Date.now() - started}ms`)
);
void run;

setTimeout(() => controller.abort(new DOMException('user cancelled', 'AbortError')), 150);
await new Promise((r) => setTimeout(r, 1200));

console.log(`signal aborted at ~150ms; tool saw abort: ${toolSawAbort}`);
console.log(`send() outcome: ${settled ?? 'STILL PENDING after 1200ms - RUN HUNG'}`);
if (!settled) {
  console.log('BUG CONFIRMED: abort during tool execution does not stop the run');
  process.exit(0); // the orphaned tool promise would otherwise hold nothing; exit explicitly
}
