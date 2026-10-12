/**
 * F1 repro: no-session-squatting is a check-then-act race.
 *
 * `ownsSession`/`sessionStored` in src/server/fetchRoutes.ts checks the owner
 * map and the durable session transcript, but the new owner is only claimed
 * AFTER the whole check finishes. Two concurrent `POST /chat` calls for the
 * same unowned session both observe "unowned" and both proceed; the later
 * claim is silently ignored, so the second caller streams a turn inside a
 * session owned by (and later denied to) the first caller.
 *
 * Deterministic: the first `sessions.load('s')` is delayed so the second
 * request's owner check completes while the first request is still inside
 * `sessionStored`, before `claimSession` runs.
 */
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing/mockModel';
import { handleChatFetch } from '../../../src/server/fetchRoutes';
import { sessionOwner } from '../../../src/server/requestGuard';
import { MemorySessionStore } from '../../../src/session/sessionStore';
import { memoryStore } from '../../../src/storage/agentStore';
import { textOf } from '../../../src/providers/content';
import type { Principal } from '../../../src/types';

const secret = 'ALICE_SECRET_API_KEY_9f4e';
let firstLoadDone = false;

const sessions = new class extends MemorySessionStore {
  override async load(id: string) {
    if (!firstLoadDone) {
      firstLoadDone = true;
      await new Promise((r) => setTimeout(r, 150)); // hold alice inside sessionStored
    }
    return super.load(id);
  }
}();

const store = memoryStore();
store.sessions = sessions;

const agent = createAgent({
  provider: mockModel([
    'ack',
    (req) => `LEAKED:${textOf(req.messages.find((m) => m.role === 'user')!.content)}`,
  ]),
  store,
});
const ctx = { agent: () => agent, name: 'f1-repro' };
const alice: Principal = { id: 'alice', type: 'user', authenticator: 'test' };
const mallory: Principal = { id: 'mallory', type: 'user', authenticator: 'test' };

const post = (input?: string) =>
  new Request('http://agent.test/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input === undefined ? { sessionId: 's' } : { sessionId: 's', input }),
  });

const aResP = handleChatFetch(post(secret), ctx, alice);
const mResP = handleChatFetch(post('mallory-injected'), ctx, mallory);
const [aRes, mRes] = await Promise.all([aResP, mResP]);
const aBody = await aRes!.text();
const mBody = await mRes!.text();

const transcript = await sessions.load('s');
const transcriptText = JSON.stringify(transcript);

// Control: now that alice owns 's', a sequential mallory request must be refused.
const late = await handleChatFetch(post('late-attempt'), ctx, mallory);
// And mallory can no longer even read the session she wrote into.
const read = await handleChatFetch(post(), ctx, mallory);

const findings: Record<string, unknown> = {
  aliceStatus: aRes!.status,
  malloryStatus: mRes!.status,
  finalOwner: sessionOwner(agent, 's'),
  mallorySeesAliceSecret: mBody.includes(secret),
  malloryMessageInTranscript: transcriptText.includes('mallory-injected'),
  transcriptLength: transcript.length,
  sequentialMalloryStatus: late!.status,
  malloryReadAfter: read!.status,
  malloryBodySnippet: mBody.slice(0, 500),
};
console.log(JSON.stringify(findings, null, 2));

const bug =
  aRes!.status === 200 &&
  mRes!.status === 200 &&
  findings.malloryMessageInTranscript === true &&
  findings.finalOwner === alice &&
  findings.sequentialMalloryStatus === 403;

console.log(bug ? 'BUG REPRODUCED: concurrent squat — mallory ran a turn in a session now owned by alice' : 'no bug');
process.exit(bug ? 0 : 1);
