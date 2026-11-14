import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { mockModel } from 'lousho/testing';
import type { LLMProvider, StreamChunk } from 'lousho';
import { startStudioServer, type StudioServerHandle } from '../index';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { AuthorSessionStore } from '../author/sessionStore';
import { AuthorTurnRunner } from '../author/turnRunner';
import { SettingsStore } from '../settingsStore';
import { SecretsStore } from '../secretsStore';
import { studioPathsFor } from '../workspace/studioPaths';
import type { AuthorServerEvent, AuthorSession } from '../../shared/authorWire';

const TOKEN = 'author-stream-token-0123456';
const REQ_A = 'req-aa03-0001';
const REQ_B = 'req-aa03-0002';
const REQ_RESUME = 'req-aa04-0001';

/** A promise the test resolves by hand (the gated model's stream pauses on it). */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A provider whose one stream emits `first` deltas, waits on `gateA`,
 * emits `second` deltas (resolving `emittedSecond` once the last was
 * yielded), waits on `gateB`, then emits `last` and finishes. Lets the
 * test park a turn mid-flight, drop the client, and resume against the
 * replay buffer while the model is still "typing".
 */
function gatedModel(script: {
  first: string[];
  second: string[];
  last: string[];
  gateA: Promise<void>;
  gateB: Promise<void>;
}): { provider: LLMProvider; emittedSecond: Promise<void> } {
  let markSecond!: () => void;
  const emittedSecond = new Promise<void>((resolve) => {
    markSecond = resolve;
  });
  const full = [...script.first, ...script.second, ...script.last].join('');
  const provider: LLMProvider = {
    name: 'gated-mock',
    defaultModel: 'gated-model',
    generate: () => Promise.reject(new Error('generate() is not used by the Author')),
    stream: () => {
      const fullStream = (async function* (): AsyncGenerator<StreamChunk> {
        for (const text of script.first) yield { type: 'text-delta', textDelta: text };
        await script.gateA;
        for (const text of script.second) yield { type: 'text-delta', textDelta: text };
        markSecond();
        await script.gateB;
        for (const text of script.last) yield { type: 'text-delta', textDelta: text };
        yield { type: 'finish', finishReason: 'stop' };
      })();
      return Promise.resolve({
        fullStream,
        textStream: (async function* () {
          yield full;
        })(),
        text: Promise.resolve(full),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      });
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: () => Promise.resolve(['gated-model']),
  };
  return { provider, emittedSecond };
}

/**
 * `WS /assistant/stream` end to end: a real `startStudioServer` with the
 * `authorRunner` test seam (providerFor -> mockModel) behind the same
 * token gate every upgrade goes through. Sessions come from the REST
 * route so the store the runner and the WS handler share sees them.
 */
describe('WS /assistant/stream (startStudioServer)', () => {
  let baseDir: string;
  let handle: StudioServerHandle;
  let model: LLMProvider;
  let origin: string;
  let session: AuthorSession;
  let otherSession: AuthorSession;
  let runner: AuthorTurnRunner;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-aa03-'));
    const home = path.join(baseDir, '.lousho');
    model = mockModel(['Hi']);
    runner = new AuthorTurnRunner({
      sessions: new AuthorSessionStore(studioPathsFor(home).sessions),
      settings: new SettingsStore(home),
      secrets: new SecretsStore(home),
      systemPrompt: () => 'You are the lousho Agent Author.',
      buildTools: () => [],
      turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
      providerFor: () => model,
    });
    handle = await startStudioServer({
      baseDir,
      port: 0,
      observe: false,
      judge: false,
      staticDir: false,
      token: TOKEN,
      studioHome: home,
      authorRunner: runner,
    });
    origin = `http://127.0.0.1:${handle.port}`;
    session = await createSession();
    otherSession = await createSession();
  });

  afterAll(async () => {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<AuthorSession> {
    const res = await fetch(`${origin}/assistant/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [STUDIO_TOKEN_HEADER]: TOKEN },
      body: '{}',
    });
    expect(res.status).toBe(201);
    return (await res.json()) as AuthorSession;
  }

  function streamUrl(sessionId: string, withToken = true): string {
    return `ws://127.0.0.1:${handle.port}/assistant/stream?session=${sessionId}${withToken ? `&token=${TOKEN}` : ''}`;
  }

  interface StreamClient {
    ws: WebSocket;
    events: AuthorServerEvent[];
  }

  /** Opens the stream and resolves once the upgrade completed. */
  function connect(sessionId: string): Promise<StreamClient> {
    const ws = new WebSocket(streamUrl(sessionId));
    const events: AuthorServerEvent[] = [];
    ws.on('message', (data) => events.push(JSON.parse(String(data)) as AuthorServerEvent));
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ ws, events }));
      ws.once('error', reject);
    });
  }

  /** Awaits one AuthorServerEvent matching `pred` from a list 'message' appends to. */
  async function waitForEvent(
    events: AuthorServerEvent[],
    pred: (event: AuthorServerEvent) => boolean,
    timeoutMs = 5000
  ): Promise<AuthorServerEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(pred);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for an AuthorServerEvent; got ${JSON.stringify(events)}`);
  }

  const chatSend = (ws: WebSocket, requestId: string, text: string) =>
    ws.send(JSON.stringify({ type: 'chat.send', requestId, text }));

  it('two sockets on one session both receive turn.started … turn.finished for a chat.send', async () => {
    model = mockModel(['Hi there']);
    const a = await connect(session.id);
    const b = await connect(session.id);
    try {
      chatSend(a.ws, REQ_A, 'say hi');
      const end = await waitForEvent(a.events, (e) => e.type === 'turn.finished' || e.type === 'turn.error');
      expect(end).toMatchObject({ type: 'turn.finished', requestId: REQ_A, finishReason: 'stop' });
      // turn.started … text.delta(s) … turn.finished, seq strictly monotone.
      expect(a.events[0]).toMatchObject({ type: 'turn.started', requestId: REQ_A, seq: 1 });
      expect(a.events.slice(1, -1).every((e) => e.type === 'text.delta' && e.requestId === REQ_A)).toBe(true);
      expect(a.events.map((e) => e.seq)).toEqual(a.events.map((_e, i) => i + 1));
      const text = a.events
        .filter((e): e is Extract<AuthorServerEvent, { type: 'text.delta' }> => e.type === 'text.delta')
        .map((e) => e.text)
        .join('');
      expect(text).toBe('Hi there');
      // The second socket was subscribed before the send: identical stream.
      await waitForEvent(b.events, (e) => e.type === 'turn.finished');
      expect(b.events).toEqual(a.events);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it('a socket on another session receives nothing', async () => {
    model = mockModel(['only for session one']);
    const a = await connect(session.id);
    const other = await connect(otherSession.id);
    try {
      chatSend(a.ws, REQ_A, 'say hi');
      await waitForEvent(a.events, (e) => e.type === 'turn.finished');
      // Give any (wrongly) routed frames a beat to arrive before asserting none did.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(other.events).toEqual([]);
    } finally {
      a.ws.close();
      other.ws.close();
    }
  });

  it('refuses the upgrade without the token (401) and closes 4404 for an unknown session', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(streamUrl(session.id, false));
      ws.on('open', () => {
        ws.close();
        resolve(0);
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(0));
    });
    expect(status).toBe(401);

    for (const badId of ['as_0000000000000000', '..']) {
      const [code, reason] = await new Promise<[number, string]>((resolve, reject) => {
        const ws = new WebSocket(streamUrl(badId));
        ws.once('close', (c, r) => resolve([c, String(r)]));
        ws.once('error', reject);
      });
      expect(code).toBe(4404);
      expect(reason).toBe('Chat not found');
    }
  });

  it('a BUSY start answers the sending socket only', async () => {
    model = mockModel([{ text: 'a slow reply', delayMs: 150 }]);
    const a = await connect(session.id);
    const b = await connect(session.id);
    try {
      chatSend(a.ws, REQ_A, 'first');
      await waitForEvent(a.events, (e) => e.type === 'turn.started');
      chatSend(b.ws, REQ_B, 'second');
      const busy = await waitForEvent(b.events, (e) => e.type === 'turn.error');
      expect(busy).toEqual({
        type: 'turn.error',
        requestId: REQ_B,
        seq: 0,
        message: 'A reply is already running in this chat. Wait for it to finish, then send again.',
        code: 'BUSY',
      });
      // The first socket only ever saw its own turn's events.
      expect(a.events.filter((e) => e.type === 'turn.error')).toEqual([]);
      await waitForEvent(a.events, (e) => e.type === 'turn.finished');
      // …and b, subscribed to the same session, saw the running turn too.
      expect(b.events.filter((e) => e.type !== 'turn.error')).toEqual(a.events);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it('chat.stop ends the running turn with finishReason stopped', async () => {
    model = mockModel([{ text: 'a long slow reply', delayMs: 500 }]);
    const a = await connect(session.id);
    try {
      chatSend(a.ws, REQ_A, 'talk');
      await waitForEvent(a.events, (e) => e.type === 'turn.started');
      a.ws.send(JSON.stringify({ type: 'chat.stop', requestId: REQ_A }));
      const end = await waitForEvent(a.events, (e) => e.type === 'turn.finished');
      expect(end).toMatchObject({ type: 'turn.finished', requestId: REQ_A, finishReason: 'stopped' });
    } finally {
      a.ws.close();
    }
  });

  it('unreadable and unknown frames answer BAD_MESSAGE on this socket only', async () => {
    const a = await connect(session.id);
    const b = await connect(session.id);
    try {
      a.ws.send('not json at all');
      const badJson = await waitForEvent(a.events, (e) => e.type === 'turn.error');
      expect(badJson).toEqual({
        type: 'turn.error',
        requestId: '',
        seq: 0,
        message: 'Studio could not read that message.',
        code: 'BAD_MESSAGE',
      });
      // chat.resume for a requestId the replay buffer never saw answers
      // UNKNOWN_REQUEST on this socket only (seq 0, per-socket reply).
      a.ws.send(JSON.stringify({ type: 'chat.resume', requestId: 'req-resume-01' }));
      const resume = await waitForEvent(a.events, (e) => e.type === 'turn.error' && e.requestId === 'req-resume-01');
      expect(resume).toEqual({
        type: 'turn.error',
        requestId: 'req-resume-01',
        seq: 0,
        message: 'This reply is no longer available. Showing the saved chat.',
        code: 'UNKNOWN_REQUEST',
      });
      // A structurally wrong message with a requestId echoes it too.
      a.ws.send(JSON.stringify({ type: 'chat.send', requestId: 'req-nope-0001' }));
      const noText = await waitForEvent(a.events, (e) => e.type === 'turn.error' && e.requestId === 'req-nope-0001');
      expect(noText).toMatchObject({ type: 'turn.error', requestId: 'req-nope-0001', seq: 0, code: 'BAD_MESSAGE' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(b.events).toEqual([]);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it('chat.resume mid-turn replays seq > afterSeq, then the live tail, with no duplicates', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const gated = gatedModel({ first: ['aa', 'bb'], second: ['cc', 'dd'], last: ['ee'], gateA: gateA.promise, gateB: gateB.promise });
    model = gated.provider;
    const a = await connect(session.id);
    let b: StreamClient | undefined;
    try {
      chatSend(a.ws, REQ_RESUME, 'talk');
      // seq 1 turn.started, seqs 2-3 the two first-stage deltas.
      await waitForEvent(a.events, (e) => e.seq === 3);
      a.ws.close();
      // The turn keeps running with no subscribers: two more deltas land
      // in the replay buffer, then the model parks on gateB. Wait on the
      // runner's own emit for seq 5 (recorded before the buffer replays).
      gateA.release();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('seq 5 never emitted')), 5000);
        const check = (_s: string, e: AuthorServerEvent) => {
          if (e.requestId === REQ_RESUME && e.seq === 5) {
            runner.off('event', check);
            clearTimeout(deadline);
            resolve();
          }
        };
        runner.on('event', check);
      });
      await gated.emittedSecond;
      // While it runs, the session record reports the in-flight requestId.
      const record = (await (
        await fetch(`${origin}/assistant/sessions/${session.id}`, { headers: { [STUDIO_TOKEN_HEADER]: TOKEN } })
      ).json()) as { runningRequestId: string | null };
      expect(record.runningRequestId).toBe(REQ_RESUME);

      // The dropped client reconnects and resumes from its last seq.
      b = await connect(session.id);
      b.ws.send(JSON.stringify({ type: 'chat.resume', requestId: REQ_RESUME, afterSeq: 3 }));
      // The replayed buffer tail: seqs 4-5 only.
      await waitForEvent(b.events, (e) => e.seq === 5);
      expect(b.events.map((e) => e.seq)).toEqual([4, 5]);
      // gateB releases the live tail: delta seq 6, turn.finished seq 7.
      gateB.release();
      await waitForEvent(b.events, (e) => e.type === 'turn.finished');
      expect(b.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
      expect(b.events.slice(0, 3).every((e) => e.type === 'text.delta')).toBe(true);
      expect(b.events[3]).toMatchObject({ type: 'turn.finished', requestId: REQ_RESUME, finishReason: 'stop' });
    } finally {
      gateA.release();
      gateB.release();
      a.ws.close();
      b?.ws.close();
    }
  });

  it('chat.resume after the turn settled sends only the terminal event', async () => {
    model = mockModel(['quick reply']);
    const a = await connect(session.id);
    let b: StreamClient | undefined;
    try {
      chatSend(a.ws, REQ_A, 'hi');
      const end = await waitForEvent(a.events, (e) => e.type === 'turn.finished');
      // The reconnect happens after the turn settled: the resume answer
      // is the terminal event alone - never the turn's deltas again.
      b = await connect(session.id);
      b.ws.send(JSON.stringify({ type: 'chat.resume', requestId: REQ_A, afterSeq: 0 }));
      await waitForEvent(b.events, (e) => e.type === 'turn.finished' || e.type === 'turn.error');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(b.events).toEqual([end]);
      // And the session record reports no running reply.
      const record = (await (
        await fetch(`${origin}/assistant/sessions/${session.id}`, { headers: { [STUDIO_TOKEN_HEADER]: TOKEN } })
      ).json()) as { runningRequestId: string | null };
      expect(record.runningRequestId).toBeNull();
    } finally {
      a.ws.close();
      b?.ws.close();
    }
  });
});
