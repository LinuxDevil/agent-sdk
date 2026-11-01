import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mockModel, type MockModel } from 'lousho/testing';
import type { NamedToolDescriptor, ToolDescriptor } from 'lousho';
import { AuthorSessionStore } from '../sessionStore';
import { SettingsStore } from '../../settingsStore';
import { SecretsStore } from '../../secretsStore';
import { AuthorTurnRunner, type AuthorStartResult, type AuthorTurnRunnerDeps } from '../turnRunner';
import { TURN_CONTEXT_HEADER } from '../turnContext';
import type { AuthorServerEvent, AuthorSession } from '../../../shared/authorWire';

/**
 * AuthorTurnRunner: one `createAgent` turn over the persisted transcript,
 * typed server events with a per-turn `seq`, one running turn per session,
 * the user message persisted at start and the assistant message at end -
 * before `turn.finished`. The `mockModel` provider rides the `providerFor`
 * seam; every scripted tool call carries an explicit unique id (mockModel
 * restarts `call_<n>` per model instance).
 */
describe('AuthorTurnRunner', () => {
  let dir: string;
  let store: AuthorSessionStore;
  let settings: SettingsStore;
  let secrets: SecretsStore;
  let session: AuthorSession;

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa02b-runner-'));
    store = new AuthorSessionStore(path.join(dir, 'sessions'));
    settings = new SettingsStore(dir);
    secrets = new SecretsStore(dir);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    session = await store.create(undefined, 'ws-test');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A minimal raw ToolDescriptor with a name (as a loader/`defineTool` result carries one). */
  function testTool(
    name: string,
    options: { execute?: (args: unknown) => unknown; failingSchema?: boolean } = {}
  ): NamedToolDescriptor {
    const inputSchema = options.failingSchema
      ? {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: () => ({ issues: [{ message: 'Required', path: ['q'] }] }),
          },
        }
      : undefined;
    return {
      name,
      displayName: name,
      ...(inputSchema !== undefined && { inputSchema }),
      execute: options.execute ?? (async () => ({ ok: true })),
      tool: { description: `test tool ${name}`, parameters: { type: 'object', properties: {} } },
    } as unknown as NamedToolDescriptor;
  }

  function makeRunner(
    model: MockModel,
    options: { tools?: ToolDescriptor[]; deps?: Partial<AuthorTurnRunnerDeps> } = {}
  ): AuthorTurnRunner {
    return new AuthorTurnRunner({
      sessions: store,
      settings,
      secrets,
      systemPrompt: () => 'You are the lousho Agent Author.',
      buildTools: () => options.tools ?? [],
      turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
      providerFor: () => model,
      now: () => new Date('2026-10-30T12:00:00.000Z'),
      ...options.deps,
    });
  }

  interface Collected {
    events: AuthorServerEvent[];
    runner: AuthorTurnRunner;
    /** Resolves with the turn.finished/turn.error event; attach BEFORE start(). */
    turnEnd: Promise<AuthorServerEvent>;
  }

  function collect(runner: AuthorTurnRunner): Collected {
    const collected: Collected = { events: [], runner, turnEnd: undefined as never };
    collected.turnEnd = new Promise<AuthorServerEvent>((resolve) => {
      runner.on('event', (sid: string, ev: AuthorServerEvent) => {
        if (sid !== session.id) return;
        collected.events.push(ev);
        if (ev.type === 'turn.finished' || ev.type === 'turn.error') resolve(ev);
      });
    });
    return collected;
  }

  const requestId = 'req-0001-aa02b';

  it('a "Hi" reply emits turn.started(1), text.delta(2), turn.finished(3, stop) and persists both messages', async () => {
    const model = mockModel(['Hi']);
    const runner = makeRunner(model);
    const { events, turnEnd } = collect(runner);

    const started = await runner.start(session.id, { requestId, text: 'say hi' });
    expect(started).toEqual({ ok: true, requestId });
    const finished = await turnEnd;

    expect(events).toEqual([
      { type: 'turn.started', requestId, seq: 1 },
      { type: 'text.delta', requestId, seq: 2, text: 'Hi' },
      { type: 'turn.finished', requestId, seq: 3, finishReason: 'stop' },
    ]);
    expect(finished).toMatchObject({ finishReason: 'stop' });

    const stored = await store.get(session.id);
    expect(stored?.transcript).toHaveLength(2);
    const [user, assistant] = stored!.transcript;
    expect(user).toMatchObject({ role: 'user', text: 'say hi' });
    if (user.role === 'user') expect(user.turnContext).toContain(TURN_CONTEXT_HEADER);
    expect(assistant).toMatchObject({
      role: 'assistant',
      requestId,
      finishReason: 'stop',
      parts: [{ type: 'text', text: 'Hi' }],
    });
  });

  it('the session file on disk already holds the assistant message when turn.finished is emitted', async () => {
    const model = mockModel(['Hi']);
    const runner = makeRunner(model);
    let onDiskAtFinished: AuthorSession | undefined;
    runner.on('event', (sid: string, ev: AuthorServerEvent) => {
      if (ev.type === 'turn.finished') {
        onDiskAtFinished = JSON.parse(
          fs.readFileSync(path.join(dir, 'sessions', `${sid}.json`), 'utf8')
        ) as AuthorSession;
      }
    });
    const { turnEnd } = collect(runner);
    await runner.start(session.id, { requestId, text: 'say hi' });
    await turnEnd;
    expect(onDiskAtFinished?.transcript).toHaveLength(2);
    expect(onDiskAtFinished?.transcript[1]).toMatchObject({ role: 'assistant' });
  });

  it('a second start while the first runs returns BUSY without touching the transcript', async () => {
    const model = mockModel([{ text: 'slow reply', delayMs: 100 }]);
    const runner = makeRunner(model);
    const { turnEnd } = collect(runner);

    const first = await runner.start(session.id, { requestId, text: 'first' });
    expect(first.ok).toBe(true);
    const second = await runner.start(session.id, { requestId: 'req-0002-aa02b', text: 'second' });
    expect(second).toEqual({
      ok: false,
      code: 'BUSY',
      message: 'A reply is already running in this chat. Wait for it to finish, then send again.',
    });
    await turnEnd;

    const stored = await store.get(session.id);
    // Only the first turn's user message + assistant reply - the busy send appended nothing.
    expect(stored?.transcript).toHaveLength(2);
    expect(stored?.transcript[0]).toMatchObject({ role: 'user', text: 'first' });
  });

  it('no API key and no providerFor -> NO_PROVIDER_KEY, nothing appended', async () => {
    const runner = new AuthorTurnRunner({
      sessions: store,
      settings,
      secrets,
      systemPrompt: () => 'prompt',
      buildTools: () => [],
      turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
    });
    const events: AuthorServerEvent[] = [];
    runner.on('event', (_sid: string, ev: AuthorServerEvent) => events.push(ev));

    const result: AuthorStartResult = await runner.start(session.id, { requestId, text: 'hi' });
    expect(result).toEqual({
      ok: false,
      code: 'NO_PROVIDER_KEY',
      message: 'Add an Anthropic API key in Settings to use the Agent Author.',
    });
    expect(events).toEqual([]);
    expect((await store.get(session.id))?.transcript).toEqual([]);
  });

  it('stop() ends the turn with finishReason "stopped" and keeps the partial text', async () => {
    const model = mockModel([{ text: 'Hello big world' }]);
    const runner = makeRunner(model);
    const { events, turnEnd } = collect(runner);
    runner.on('event', (sid: string, ev: AuthorServerEvent) => {
      if (ev.type === 'text.delta') runner.stop(sid, requestId);
    });

    await runner.start(session.id, { requestId, text: 'talk' });
    await turnEnd;

    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', finishReason: 'stopped' });
    const stored = await store.get(session.id);
    const assistant = stored?.transcript.at(-1);
    // The abort lands mid-stream: a strict prefix of 'Hello big world' was kept.
    expect(assistant).toMatchObject({ finishReason: 'stopped' });
    if (assistant?.role === 'assistant') {
      expect(assistant.parts).toHaveLength(1);
      const part = assistant.parts[0];
      expect(part.type).toBe('text');
      if (part.type === 'text') {
        expect('Hello big world'.startsWith(part.text)).toBe(true);
        expect(part.text.length).toBeGreaterThan(0);
        expect(part.text.length).toBeLessThan('Hello big world'.length);
      }
    }
    // A stale stop answers false.
    expect(runner.stop(session.id, requestId)).toBe(false);
  });

  it('three invalid-argument calls to one tool end the turn with tool_input_cap', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'strict_tool', args: { bad: 1 }, id: 'call_bad1' }] },
      { toolCalls: [{ name: 'strict_tool', args: { bad: 2 }, id: 'call_bad2' }] },
      { toolCalls: [{ name: 'strict_tool', args: { bad: 3 }, id: 'call_bad3' }] },
    ]);
    const runner = makeRunner(model, { tools: [testTool('strict_tool', { failingSchema: true })] });
    const { events, turnEnd } = collect(runner);

    await runner.start(session.id, { requestId, text: 'use the tool' });
    const finished = await turnEnd;

    expect(finished).toMatchObject({ type: 'turn.finished', finishReason: 'tool_input_cap' });
    expect(events.filter((e) => e.type === 'tool.result' && e.state === 'error')).toHaveLength(3);
    const stored = await store.get(session.id);
    const assistant = stored?.transcript.at(-1);
    expect(assistant).toMatchObject({ finishReason: 'tool_input_cap' });
    if (assistant?.role === 'assistant') {
      expect(assistant.parts.filter((p) => p.type === 'tool' && p.state === 'error')).toHaveLength(3);
    }
    // The cap aborted the run after the third error - the model was not called a fourth time.
    expect(model.calls).toHaveLength(3);
  });

  it('a tool that throws produces tool.result {state: error} and the turn still finishes', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'broken_tool', args: {}, id: 'call_throw1' }] },
      { text: 'recovered' },
    ]);
    const runner = makeRunner(model, {
      tools: [
        testTool('broken_tool', {
          execute: () => {
            throw new Error('kaput');
          },
        }),
      ],
    });
    const { events, turnEnd } = collect(runner);

    await runner.start(session.id, { requestId, text: 'go' });
    const finished = await turnEnd;

    expect(finished).toMatchObject({ type: 'turn.finished', finishReason: 'stop' });
    const toolResult = events.find((e) => e.type === 'tool.result');
    expect(toolResult).toMatchObject({
      type: 'tool.result',
      name: 'broken_tool',
      state: 'error',
      output: { ok: false, code: 'TOOL_ERROR', error: 'kaput' },
    });
    const stored = await store.get(session.id);
    expect(stored?.transcript.at(-1)).toMatchObject({ finishReason: 'stop' });
  });

  it('the second turn sends the first turn\'s messages to the model', async () => {
    const model = mockModel(['Hi', 'Second reply']);
    const runner = makeRunner(model);
    const first = collect(runner);
    await runner.start(session.id, { requestId, text: 'say hi' });
    await first.turnEnd;

    const second = collect(runner);
    const started = await runner.start(session.id, { requestId: 'req-0002-aa02b', text: 'again' });
    expect(started.ok).toBe(true);
    await second.turnEnd;

    expect(model.calls).toHaveLength(2);
    // calls[].messages includes createAgent's system message (the instructions) first.
    const secondCall = model.calls[1].messages;
    expect(secondCall).toHaveLength(4);
    expect(secondCall[0].role).toBe('system');
    expect(secondCall[1].role).toBe('user');
    expect(String(secondCall[1].content)).toContain(TURN_CONTEXT_HEADER);
    expect(String(secondCall[1].content)).toContain('say hi');
    expect(secondCall[2]).toMatchObject({ role: 'assistant', content: 'Hi' });
    expect(secondCall[3].role).toBe('user');
    expect(String(secondCall[3].content)).toContain('again');
  });

  it('blank text, overlong text and a bad request id are INVALID_INPUT, nothing appended', async () => {
    const runner = makeRunner(mockModel(['x']));
    for (const [req, message] of [
      [{ requestId, text: '   ' }, 'Type a message first.'],
      [{ requestId, text: 'x'.repeat(20_001) }, 'That message is too long (max 20,000 characters).'],
      [{ requestId: 'short', text: 'hi' }, 'Bad request id.'],
    ] as const) {
      const result = await runner.start(session.id, req);
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', message });
    }
    expect((await store.get(session.id))?.transcript).toEqual([]);
  });

  it('an unknown session id is NOT_FOUND', async () => {
    const runner = makeRunner(mockModel(['x']));
    const result = await runner.start('as_0000000000000000', { requestId, text: 'hi' });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', message: 'Chat not found.' });
  });

  it('continueAfterUiEvent runs a turn over the stored uiEvent user message', async () => {
    await store.update(session.id, (s) => ({
      ...s,
      transcript: [
        ...s.transcript,
        {
          id: 'm_uievent',
          role: 'user',
          text: '',
          at: '2026-10-30T11:00:00.000Z',
          uiEvent: { kind: 'save', proposalId: 'p_1', agentId: 'bot-1', version: 2 },
        },
      ],
    }));
    const model = mockModel(['Noted.']);
    const runner = makeRunner(model);
    const { events, turnEnd } = collect(runner);

    const result = await runner.continueAfterUiEvent(session.id);
    expect(result.ok).toBe(true);
    await turnEnd;

    expect(events[0]).toMatchObject({ type: 'turn.started' });
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', finishReason: 'stop' });
    // The model saw the [UI event] rendering of the stored message - and nothing else
    // (calls[].messages includes createAgent's system message first).
    expect(model.calls[0].messages).toHaveLength(2);
    expect(model.calls[0].messages[0].role).toBe('system');
    expect(String(model.calls[0].messages[1].content)).toContain('[UI event] User applied proposal p_1');
    const stored = await store.get(session.id);
    expect(stored?.transcript).toHaveLength(2);
    expect(stored?.transcript.at(-1)).toMatchObject({ role: 'assistant', finishReason: 'stop' });
  });
});
