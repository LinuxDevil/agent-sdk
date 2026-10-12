/**
 * REPRO (variant): aborting a RESUMED approval while the approved tool
 * executes hangs forever too - executeApprovedTool() awaits
 * executeToolWithSandboxGuard() (resume.ts:1473-1481) with no signal race,
 * the same missing guard as ToolBatch's `Promise.all(this.running)`.
 *
 * Expected: approvals.resolve() settles 'aborted' soon after the signal.
 * Actual:   it never settles.
 */
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { defineTool } from '../../../src/tools/defineTool';
import { mockModel } from '../../../src/testing/mockModel';

const slow = defineTool({
  name: 'slow_tool',
  description: 'never finishes, ignores abort',
  input: z.object({}),
  needsApproval: true,
  execute: async () => new Promise<string>(() => {}),
});

const agent = createAgent({
  prompt: 'test',
  provider: mockModel([
    { toolCalls: [{ name: 'slow_tool', args: {} }] },
    { text: 'should never reach' },
  ]),
  tools: [slow],
});

const paused = await agent.send('go');
if (paused.finishReason !== 'awaiting-approval') throw new Error('expected a pause');

const controller = new AbortController();
const started = Date.now();
let settled: string | undefined;
void agent.approvals.resolve({ id: paused.approvalId!, approved: true }, { signal: controller.signal }).then(
  (r) => (settled = `resolved finish=${r.finishReason} after ${Date.now() - started}ms`),
  (e) => (settled = `rejected ${e?.name ?? e} after ${Date.now() - started}ms`)
);

setTimeout(() => controller.abort(new DOMException('user cancelled', 'AbortError')), 150);
await new Promise((r) => setTimeout(r, 1200));

console.log(`resolve() outcome: ${settled ?? 'STILL PENDING after 1200ms - RESUME HUNG'}`);
if (!settled) console.log('BUG CONFIRMED: abort during a resumed approval tool hangs');
process.exit(0);
