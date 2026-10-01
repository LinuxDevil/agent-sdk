import { createHmac } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SlackTriggerAdapter } from './SlackTriggerAdapter';
import { verifySlackSignature } from '../webhookAuth';
import type { ExecutionResult } from '../../execution/AgentExecutor';
import type { Logger } from '../../execution/logger';
import type { RunnableAgent } from '../types';

const SECRET = 'slack-signing-secret';
const NOW_SECONDS = 1_700_000_000;
const noopAgent: RunnableAgent = { send: vi.fn() };

function sign(body: string, timestamp: string | number = NOW_SECONDS, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

function signedHeaders(body: string, overrides: Record<string, string | undefined> = {}) {
  return {
    'x-slack-request-timestamp': String(NOW_SECONDS),
    'x-slack-signature': sign(body),
    ...overrides,
  };
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const messageBody = JSON.stringify({
  type: 'event_callback',
  event: { type: 'message', channel: 'C1', text: 'hello agent' },
});
const challengeBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });

function setup(options: { signingSecret?: string; logger?: Logger } = {}) {
  vi.useFakeTimers({ now: NOW_SECONDS * 1000, toFake: ['Date'] });
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);
  const adapter = new SlackTriggerAdapter({ webhookUrl: 'https://hooks.slack.test/x', fetchImpl, ...options });
  const onEvent = vi.fn().mockResolvedValue({ text: 'reply' } as ExecutionResult);
  adapter.listen(noopAgent, onEvent);
  return { adapter, onEvent };
}

type Built = { headers: Record<string, string | undefined>; rawBody: string };

describe('SlackTriggerAdapter signature verification', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts a correctly signed request and runs the agent', async () => {
    const { adapter, onEvent } = setup({ signingSecret: SECRET });
    const res = await adapter.handleRequest({ headers: signedHeaders(messageBody), rawBody: Buffer.from(messageBody) });
    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledWith('hello agent', { channel: 'C1' });
  });

  const staleHeaders = (b: string, offset: number) => ({
    'x-slack-request-timestamp': String(NOW_SECONDS + offset),
    'x-slack-signature': sign(b, NOW_SECONDS + offset),
  });
  const rejected: Array<[string, (b: string) => Built]> = [
    ['a wrong secret', (b) => ({ headers: { 'x-slack-request-timestamp': String(NOW_SECONDS), 'x-slack-signature': sign(b, NOW_SECONDS, 'other') }, rawBody: b })],
    ['a tampered body', (b) => ({ headers: signedHeaders(b), rawBody: b.replace('hello', 'HELLO') })],
    ['a stale timestamp', (b) => ({ headers: staleHeaders(b, -301), rawBody: b })],
    ['a future timestamp', (b) => ({ headers: staleHeaders(b, 301), rawBody: b })],
    ['a missing signature header', (b) => ({ headers: signedHeaders(b, { 'x-slack-signature': undefined }), rawBody: b })],
    ['a missing timestamp header', (b) => ({ headers: signedHeaders(b, { 'x-slack-request-timestamp': undefined }), rawBody: b })],
    ['a signature of the wrong length', (b) => ({ headers: signedHeaders(b, { 'x-slack-signature': sign(b).slice(0, -2) }), rawBody: b })],
    ['a non-hex signature', (b) => ({ headers: signedHeaders(b, { 'x-slack-signature': `v0=${'z'.repeat(64)}` }), rawBody: b })],
    ['a signature without the v0= prefix', (b) => ({ headers: signedHeaders(b, { 'x-slack-signature': sign(b).slice(3) }), rawBody: b })],
  ];

  it.each(rejected)('rejects %s with a generic 401 and never runs the agent', async (_name, build) => {
    const logger = makeLogger();
    const { adapter, onEvent } = setup({ signingSecret: SECRET, logger });
    const res = await adapter.handleRequest(build(messageBody));
    expect(res).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    expect(onEvent).not.toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('v0=');
  });

  it('answers a signed url_verification challenge', async () => {
    const { adapter } = setup({ signingSecret: SECRET });
    const res = await adapter.handleRequest({ headers: signedHeaders(challengeBody), rawBody: challengeBody });
    expect(res).toEqual({ status: 200, body: { challenge: 'abc123' } });
  });

  it('rejects an unsigned url_verification challenge when a signing secret is set', async () => {
    const { adapter } = setup({ signingSecret: SECRET });
    const res = await adapter.handleRequest({ headers: {}, rawBody: challengeBody });
    expect(res.status).toBe(401);
  });

  it('still answers an unsigned challenge when no signing secret is set (backwards compatible)', async () => {
    const { adapter } = setup();
    const res = await adapter.handleRequest({ headers: {}, rawBody: challengeBody });
    expect(res).toEqual({ status: 200, body: { challenge: 'abc123' } });
  });

  it('returns 400 for a signed non-JSON body and ignores bot messages', async () => {
    const { adapter, onEvent } = setup({ signingSecret: SECRET });
    expect((await adapter.handleRequest({ headers: signedHeaders('nope'), rawBody: 'nope' })).status).toBe(400);
    const bot = JSON.stringify({ type: 'event_callback', event: { type: 'message', channel: 'C1', text: 'x', bot_id: 'B1' } });
    expect((await adapter.handleRequest({ headers: signedHeaders(bot), rawBody: bot })).status).toBe(200);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('warns once at listen() when no signingSecret is set, and not when it is', () => {
    const logger = makeLogger();
    const adapter = new SlackTriggerAdapter({ logger });
    adapter.listen(noopAgent, vi.fn());
    adapter.listen(noopAgent, vi.fn());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/signingSecret.*api-overview/s);

    const quiet = makeLogger();
    new SlackTriggerAdapter({ logger: quiet, signingSecret: SECRET }).listen(noopAgent, vi.fn());
    expect(quiet.warn).not.toHaveBeenCalled();
  });
});

describe('verifySlackSignature', () => {
  const base = { signingSecret: SECRET, timestamp: String(NOW_SECONDS), rawBody: messageBody, now: NOW_SECONDS * 1000 };

  it('accepts a valid signature (string or Buffer body) and rejects bad input without throwing', () => {
    const signature = sign(messageBody);
    expect(verifySlackSignature({ ...base, signature })).toBe(true);
    expect(verifySlackSignature({ ...base, signature, rawBody: Buffer.from(messageBody) })).toBe(true);
    expect(verifySlackSignature({ ...base, signature: undefined })).toBe(false);
    expect(verifySlackSignature({ ...base, signature, timestamp: 'abc' })).toBe(false);
    expect(verifySlackSignature({ ...base, signature, signingSecret: '' })).toBe(false);
    expect(verifySlackSignature({ ...base, signature, now: (NOW_SECONDS + 301) * 1000 })).toBe(false);
    expect(verifySlackSignature({ ...base, signature, now: (NOW_SECONDS + 299) * 1000 })).toBe(true);
  });
});
