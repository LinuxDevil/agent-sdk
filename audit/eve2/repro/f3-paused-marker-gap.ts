/**
 * F3 repro: the `<id>.paused` marker (Eve EVE-0) is written by
 * `AgentSession.markPaused()` inside `record()` — AFTER the executor already
 * saved the turn's 'awaiting-approval' checkpoint. `agent.send(msg,
 * { sessionId })` guards on `assertNotPaused`, which reads the marker. In the
 * gap between "pause checkpoint saved" and "marker written", a durable run
 * under the session's id is admitted and runs to completion beside the paused
 * turn — exactly what the marker exists to refuse.
 *
 * Deterministic: a wrapper on checkpointStore.save defers the `<id>.paused`
 * write until a concurrent agent.send has been admitted and finished.
 */
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing/mockModel';
import { memoryStore } from '../../../src/storage/agentStore';
import { defineTool } from '../../../src/tools/defineTool';
import { SessionAwaitingApprovalError } from '../../../src/execution/errors';
import type { Checkpoint, CheckpointStore } from '../../../src/execution/checkpoint';

const store = memoryStore();
const inner = store.checkpoints;

let sideResult: unknown;
let sideError: unknown;
const wrapped: CheckpointStore = {
  ...inner,
  async save(id: string, checkpoint: Checkpoint) {
    if (id === 's.paused') {
      // We are inside markPaused(), just before the marker lands. Fire the
      // durable run the marker is meant to refuse.
      try {
        sideResult = await agent.send('side run under paused id', { sessionId: 's' });
      } catch (e) {
        sideError = e;
      }
    }
    return inner.save(id, checkpoint);
  },
  load: inner.load?.bind(inner),
  delete: inner.delete?.bind(inner),
  history: inner.history?.bind(inner),
  list: inner.list?.bind(inner),
} as CheckpointStore;

const gated = defineTool({
  name: 'gated',
  description: 'needs approval',
  input: z.object({}),
  needsApproval: true,
  execute: async () => 'ran',
});

const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'gated', args: {} }] }, 'side-run-finished', 'extra']),
  tools: [gated],
  store: { ...store, checkpoints: wrapped },
});

const session = agent.session({ id: 's' });
const paused = await session.send('go');

let postMarkerError: unknown;
try {
  await agent.send('after marker', { sessionId: 's' });
} catch (e) {
  postMarkerError = e;
}

const findings = {
  pausedFinishReason: paused.finishReason,
  sideRun: sideResult ? { finishReason: (sideResult as { finishReason?: string }).finishReason, text: (sideResult as { text?: string }).text } : undefined,
  sideError: sideError ? String((sideError as Error).message ?? sideError) : undefined,
  afterMarkerError:
    postMarkerError instanceof SessionAwaitingApprovalError ? 'SessionAwaitingApprovalError' : String(postMarkerError),
};
console.log(JSON.stringify(findings, null, 2));

const bug =
  paused.finishReason === 'awaiting-approval' &&
  ((sideResult as { finishReason?: string })?.finishReason === 'finished' ||
    (sideResult as { finishReason?: string })?.finishReason === 'stop') &&
  (sideResult as { text?: string })?.text === 'side-run-finished' &&
  findings.afterMarkerError === 'SessionAwaitingApprovalError';

console.log(bug ? 'BUG REPRODUCED: durable run admitted beside paused turn before marker write' : 'no bug');
process.exit(bug ? 0 : 1);
