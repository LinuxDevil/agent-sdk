/**
 * LOU-T2: durable checkpointing on the cloudflare-worker target, driven
 * through the REAL, tsup-built dist/worker.js bundle - same standard LOU-I3/
 * LOU-K3 already hold this adapter to ("verified genuinely Workers-
 * compatible, zero Node-builtin references in the built bundle").
 *
 * The built Worker's fetch() handler only exposes GET /health and POST
 * /chat (no HTTP endpoint for resolving an approval-gate pause - that's an
 * existing, separate gap this ticket doesn't add), so this proves the part
 * of Factor 6 that a Worker deployment can exercise end-to-end over HTTP:
 * plain run/crash/resume checkpointing via CheckpointStore, using
 * AGENT_CHECKPOINTS as a genuine (mocked) Workers KV binding.
 *
 *  1. A first /chat call, with a tool-triggering message and a sessionId,
 *     runs to completion inside the built bundle. A spy on the mock KV's
 *     put() captures the REAL mid-run Checkpoint the bundle's
 *     AgentExecutor/KVCheckpointStore wrote after the tool result (not a
 *     hand-crafted fixture) - proving the wiring in prepareWorkerSpec()/
 *     checkpointStoreFromEnv() genuinely calls kv.put() with a real
 *     Checkpoint-shaped payload.
 *  2. That captured checkpoint is replayed into a FRESH mock KV, under a
 *     new sessionId, standing in for "this session's checkpoint survived
 *     because the run crashed/the isolate was recycled before finishing".
 *     A second, independent /chat call to the SAME built bundle, with an
 *     unrelated request body, resumes from it - proven by the response
 *     containing the pre-seeded conversation history the request body
 *     itself never mentioned, which is only possible if the bundle's
 *     fetch() handler genuinely rehydrated from KV via checkpointStoreFromEnv().
 *
 * (approval-gate pause/resume through KVCheckpointStore, i.e. proving it
 * satisfies resumeAfterApproval()'s contract, is covered directly against
 * AgentExecutor/resumeAfterApproval in ../kvCheckpointStore.test.ts - the
 * same store, exercised through the SDK's own execution engine rather than
 * through this adapter's HTTP surface.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudflareWorkerAdapter, findNodeBuiltinReferences } from './cloudflare';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import type { Checkpoint } from '../../execution/checkpoint';

function writeSpec(dir: string, spec: Record<string, unknown>): string {
  const specPath = path.join(dir, 'agent.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

const SPEC = {
  name: 'CF Checkpoint Test Agent',
  prompt: 'You are a helpful edge agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['current-date', 'day-name'],
};

/** In-memory stand-in for a Cloudflare KV namespace binding. */
function createMockKV() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}

type WorkerHandler = { fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response> };

describe('cloudflare-worker: durable checkpointing (LOU-T2, built bundle)', () => {
  let outDir: string;
  let handler: WorkerHandler;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-cf-checkpoint-'));
    outDir = path.join(dir, 'out');
    await CloudflareWorkerAdapter.scaffold(writeSpec(dir, SPEC), outDir);
    await CloudflareWorkerAdapter.build(outDir);

    const bundlePath = path.join(outDir, 'dist', 'worker.js');
    // Same LOU-I3/LOU-K3 bar this whole adapter is held to: the checkpoint
    // wiring must not have leaked any node: builtin into the bundle either.
    expect(findNodeBuiltinReferences(fs.readFileSync(bundlePath, 'utf8'))).toEqual([]);

    const mod = await import(pathToFileURL(bundlePath).href);
    handler = mod.default as WorkerHandler;
  }, 120_000);

  it('scaffolds wrangler.toml with a documented, commented-out AGENT_CHECKPOINTS KV binding', () => {
    const toml = fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8');
    expect(toml).toContain(CHECKPOINT_KV_BINDING);
    expect(toml).toContain('# [[kv_namespaces]]');
    expect(toml).toContain(`# binding = "${CHECKPOINT_KV_BINDING}"`);
    expect(toml).toContain('wrangler kv namespace create');
  });

  it('with no AGENT_CHECKPOINTS binding, a sessionId is accepted but checkpointing is silently skipped', async () => {
    const res = await handler.fetch(
      new Request('http://worker/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'hi', sessionId: 'no-kv-session' }),
      }),
      {} // no AGENT_CHECKPOINTS binding at all
    );
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('This is a mock response.');
  });

  it('rejects a non-string sessionId with 400', async () => {
    const res = await handler.fetch(
      new Request('http://worker/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'hi', sessionId: 12345 }),
      })
    );
    expect(res.status).toBe(400);
  });

  it('a real run through the built bundle writes a checkpoint to KV mid-run and deletes it on completion', async () => {
    const kv = createMockKV();
    const sessionId = 'writes-and-completes';

    const res = await handler.fetch(
      new Request('http://worker/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'please call current-date for me', sessionId }),
      }),
      { [CHECKPOINT_KV_BINDING]: kv }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finishReason).toBe('stop');

    // The run completed inside this single request/response cycle, so
    // AgentExecutor's terminal-state cleanup (see AgentExecutor.ts) deletes
    // the checkpoint before returning - proven here via the real built
    // bundle + a real (mocked) KV binding, not a re-implementation of that
    // logic.
    expect(await kv.get(`checkpoints/${sessionId}`)).toBeNull();
  });

  it('pause -> resume: a checkpoint genuinely produced by the built bundle mid-run is rehydrated by a LATER, independent request', async () => {
    // --- Leg 1: capture a REAL mid-run checkpoint via a put() spy -------
    const capturingKv = createMockKV();
    const capturedPuts: Checkpoint[] = [];
    const originalPut = capturingKv.put.bind(capturingKv);
    capturingKv.put = async (key: string, value: string) => {
      if (key.startsWith('checkpoints/')) {
        capturedPuts.push(JSON.parse(value) as Checkpoint);
      }
      return originalPut(key, value);
    };

    const captureSessionId = 'capture-session';
    const captureRes = await handler.fetch(
      new Request('http://worker/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'please call current-date now', sessionId: captureSessionId }),
      }),
      { [CHECKPOINT_KV_BINDING]: capturingKv }
    );
    expect(captureRes.status).toBe(200);

    // A checkpoint was genuinely written after the tool result, mid-run -
    // this is the real payload the built bundle's AgentExecutor produced,
    // not a hand-crafted fixture.
    expect(capturedPuts.length).toBeGreaterThan(0);
    const midRunCheckpoint = capturedPuts[0];
    expect(midRunCheckpoint.sessionId).toBe(captureSessionId);
    expect(midRunCheckpoint.messages.length).toBeGreaterThan(0);
    // A distinctive marker proving these ARE this run's real messages, not
    // synthesized ones - the tool result role/name will be 'current-date'.
    expect(midRunCheckpoint.messages.some((m) => (m as any).name === 'current-date')).toBe(true);

    // --- Leg 2: replay that real checkpoint into a FRESH KV/session, ----
    // standing in for "the isolate serving leg 1 was recycled/crashed
    // after this checkpoint was durably written, before the run finished".
    const resumeSessionId = 'resume-session-from-real-checkpoint';
    const resumeKv = createMockKV();
    await resumeKv.put(
      `checkpoints/${resumeSessionId}`,
      JSON.stringify({ ...midRunCheckpoint, sessionId: resumeSessionId })
    );

    // A completely independent request, whose own body text is unrelated
    // to the pre-pause conversation - if the response reflects the seeded
    // checkpoint's prior messages, that can only be because the built
    // bundle's fetch() handler genuinely rehydrated via
    // checkpointStoreFromEnv()/KVCheckpointStore.load(), never because of
    // anything in this request's own input.
    const resumeRes = await handler.fetch(
      new Request('http://worker/chat', {
        method: 'POST',
        body: JSON.stringify({ message: 'totally unrelated follow-up text', sessionId: resumeSessionId }),
      }),
      { [CHECKPOINT_KV_BINDING]: resumeKv }
    );

    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.finishReason).toBe('stop');

    // The resumed run's message history starts with EXACTLY the seeded
    // checkpoint's pre-pause messages (rehydration ignores this request's
    // own `message` entirely - see AgentExecutor.ts's rehydration branch),
    // plus new messages appended to finish the run.
    expect(resumeBody.messages.length).toBeGreaterThan(midRunCheckpoint.messages.length);
    expect(resumeBody.messages.slice(0, midRunCheckpoint.messages.length)).toEqual(midRunCheckpoint.messages);
    expect(
      resumeBody.messages.some(
        (m: any) => typeof m.content === 'string' && m.content.includes('totally unrelated follow-up text')
      )
    ).toBe(false);

    // Completed to a terminal state again, so the resumed session's
    // checkpoint was cleaned up too.
    expect(await resumeKv.get(`checkpoints/${resumeSessionId}`)).toBeNull();
  });
});
