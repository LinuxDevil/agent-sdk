/**
 * F2 repro: `AgentSession.recordFailure()` writes a failed turn's `lastError`
 * onto whatever checkpoint currently sits under `<id>.turn-<n>` — WITHOUT the
 * run-lease fencing that `saveStepCheckpoint` uses (saveStepCheckpoint goes
 * through `RunLease.save` -> `saveIfLeased`; recordFailure calls the raw
 * `checkpointStore.save`).
 *
 * Scenario: run A of session 's' stalls mid-turn; run B takes over the lease
 * of 's.turn-0' and writes its own checkpoint (businessState 'VICTIM'). A's
 * provider call then fails permanently (401). A's `recordFailure` loads the
 * checkpoint — B's — and saves B's checkpoint back with A's `lastError`
 * (`retryable:false`) and `attempts+1`. B's run is now permanently poisoned:
 * every later send refuses with LOUSHO_SESSION_TURN_FAILED.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing/mockModel';
import { fileStore } from '../../../src/storage/fileStore';
import { defineTool } from '../../../src/tools/defineTool';
import { CompactedLLMProviderError } from '../../../src/execution/errors';

const dir = mkdtempSync(join(tmpdir(), 'f2-poison-'));
const store = fileStore(dir);

const authFailure = new CompactedLLMProviderError({
  error: 'provider 401: invalid API key',
  category: 'auth-failure',
  retryable: false,
  providerName: 'mock',
  statusCode: 401,
});

const noop = defineTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => 'ok',
});

const agent = createAgent({
  provider: mockModel([
    { toolCalls: [{ name: 'noop', args: {} }] },
    () => {
      sabotage();
      throw authFailure;
    },
  ]),
  tools: [noop],
  store,
});

function sabotage() {
  // "Run B" has taken over the turn: its own lease (different realm => not
  // provably dead) and its own checkpoint body under the same turn id.
  mkdirSync(join(dir, 'leases'), { recursive: true });
  writeFileSync(
    join(dir, 'leases', 's.turn-0.json'),
    JSON.stringify({
      owner: `${process.pid}:victim-realm:${randomUUID()}`,
      expiresAt: Date.now() + 60_000,
      host: hostname(),
      ttlMs: 60_000,
    })
  );
  const victim = JSON.parse(readFileSync(join(dir, 'checkpoints', 's.turn-0.json'), 'utf8'));
  victim.businessState = 'VICTIM-RUN-B';
  victim.attempts = 7;
  victim.stepIndex = 99;
  victim.messages.push({ role: 'user', content: 'victim-run-marker' });
  writeFileSync(join(dir, 'checkpoints', 's.turn-0.json'), JSON.stringify(victim));
}

const session = agent.session({ id: 's' });
let sendError: unknown;
try {
  await session.send('go');
} catch (e) {
  sendError = e;
}

const after = JSON.parse(readFileSync(join(dir, 'checkpoints', 's.turn-0.json'), 'utf8'));

// The victim run finishes and releases its lease; the poisoned checkpoint stays.
rmSync(join(dir, 'leases', 's.turn-0.json'), { force: true });

let resumeError: unknown;
try {
  await agent.session({ id: 's' }).send('more');
} catch (e) {
  resumeError = e;
}

const findings = {
  sendError: String((sendError as Error)?.message ?? sendError),
  checkpointSessionId: after.sessionId,
  businessState: after.businessState,
  attempts: after.attempts,
  lastError: after.lastError,
  hasVictimMarker: JSON.stringify(after.messages).includes('victim-run-marker'),
  nextSendError: (resumeError as { code?: string; message?: string })?.code ?? String(resumeError),
};
console.log(JSON.stringify(findings, null, 2));

const bug =
  after.businessState === 'VICTIM-RUN-B' &&
  after.lastError?.retryable === false &&
  after.lastError?.message?.includes('401') &&
  after.attempts === 8 &&
  findings.hasVictimMarker === true &&
  findings.nextSendError === 'LOUSHO_SESSION_TURN_FAILED';

console.log(bug ? 'BUG REPRODUCED: unfenced recordFailure poisoned a foreign checkpoint' : 'no bug');
rmSync(dir, { recursive: true, force: true });
process.exit(bug ? 0 : 1);
