import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { WebhookTriggerAdapter, WebhookTriggerHandle, WebhookTriggerAdapterOptions } from './WebhookTriggerAdapter';
import { ExecutionResult } from '../../execution/AgentExecutor';
import { Logger } from '../../execution/logger';
import { RunnableAgent } from '../types';

const SECRET = 'whsec_test_secret';
const result: ExecutionResult = {
  text: 'ok',
  messages: [],
  toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: 'stop',
  steps: 1,
};
const noopAgent: RunnableAgent = { send: vi.fn() };

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function post(port: number, body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function sign(body: string, secret = SECRET, algorithm: 'sha256' | 'sha1' = 'sha256'): string {
  return `${algorithm}=${createHmac(algorithm, secret).update(body).digest('hex')}`;
}

async function waitForPort(handle: WebhookTriggerHandle): Promise<number> {
  for (let i = 0; i < 100 && handle.port === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return handle.port;
}

describe('WebhookTriggerAdapter auth', () => {
  let handle: WebhookTriggerHandle | undefined;
  const onEvent = vi.fn();

  afterEach(async () => {
    onEvent.mockReset();
    await handle?.stop();
    handle = undefined;
  });

  async function start(options: WebhookTriggerAdapterOptions): Promise<number> {
    onEvent.mockResolvedValue(result);
    handle = new WebhookTriggerAdapter({ host: '127.0.0.1', ...options }).listen(noopAgent, onEvent);
    return waitForPort(handle);
  }

  describe('hmac', () => {
    const body = JSON.stringify({ input: 'hello' });

    it('accepts a valid signature', async () => {
      const port = await start({ auth: { type: 'hmac', secret: SECRET } });
      const res = await post(port, body, { 'x-signature-256': sign(body) });
      expect(res.status).toBe(200);
      expect(onEvent).toHaveBeenCalledWith('hello', expect.anything());
    });

    it('verifies the raw bytes, not re-serialized JSON', async () => {
      const raw = '{ "input":   "spaced"  }';
      const port = await start({ auth: { type: 'hmac', secret: SECRET } });
      const res = await post(port, raw, { 'x-signature-256': sign(raw) });
      expect(res.status).toBe(200);
      expect(onEvent).toHaveBeenCalledWith('spaced', expect.anything());
    });

    it('rejects an invalid signature, a missing header and a wrong-length signature with 401', async () => {
      const port = await start({ auth: { type: 'hmac', secret: SECRET } });
      for (const headers of [
        { 'x-signature-256': sign(body, 'wrong-secret') },
        {},
        { 'x-signature-256': 'sha256=abc' },
        { 'x-signature-256': 'sha256=' },
        { 'x-signature-256': sign(body).slice(7) },
      ] as Record<string, string>[]) {
        expect((await post(port, body, headers)).status).toBe(401);
      }
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('rejects a tampered body', async () => {
      const port = await start({ auth: { type: 'hmac', secret: SECRET } });
      const res = await post(port, JSON.stringify({ input: 'evil' }), { 'x-signature-256': sign(body) });
      expect(res.status).toBe(401);
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('supports a custom header, sha1 and an empty prefix', async () => {
      const port = await start({
        auth: { type: 'hmac', secret: SECRET, header: 'X-Hub-Signature', algorithm: 'sha1' },
      });
      expect((await post(port, body, { 'x-hub-signature': sign(body, SECRET, 'sha1') })).status).toBe(200);
      await handle?.stop();
      const bare = await start({ auth: { type: 'hmac', secret: SECRET, prefix: '' } });
      const digest = createHmac('sha256', SECRET).update(body).digest('hex');
      expect((await post(bare, body, { 'x-signature-256': digest })).status).toBe(200);
    });

    describe('with a timestamp header', () => {
      const auth = { type: 'hmac', secret: SECRET, timestampHeader: 'x-timestamp', toleranceSeconds: 60 } as const;
      const signed = (ts: string) =>
        `sha256=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
      const now = () => String(Math.floor(Date.now() / 1000));

      it('accepts a fresh timestamp signed together with the body', async () => {
        const port = await start({ auth });
        const ts = now();
        const res = await post(port, body, { 'x-signature-256': signed(ts), 'x-timestamp': ts });
        expect(res.status).toBe(200);
      });

      it('rejects a stale (replayed) request even though the signature is valid', async () => {
        const port = await start({ auth });
        const ts = String(Math.floor(Date.now() / 1000) - 3600);
        const res = await post(port, body, { 'x-signature-256': signed(ts), 'x-timestamp': ts });
        expect(res.status).toBe(401);
      });

      it('rejects a missing or non-numeric timestamp, and a timestamp not covered by the signature', async () => {
        const port = await start({ auth });
        const ts = now();
        expect((await post(port, body, { 'x-signature-256': signed(ts) })).status).toBe(401);
        expect((await post(port, body, { 'x-signature-256': signed('abc'), 'x-timestamp': 'abc' })).status).toBe(401);
        expect((await post(port, body, { 'x-signature-256': sign(body), 'x-timestamp': ts })).status).toBe(401);
      });
    });
  });

  describe('bearer', () => {
    it('accepts the right token and rejects wrong, missing and malformed ones', async () => {
      const port = await start({ auth: { type: 'bearer', token: 's3cret-token' } });
      expect((await post(port, '{}', { authorization: 'Bearer s3cret-token' })).status).toBe(200);
      expect((await post(port, '{}', { authorization: 'Bearer nope' })).status).toBe(401);
      expect((await post(port, '{}', { authorization: 'Bearer s3cret-tokeX' })).status).toBe(401);
      expect((await post(port, '{}', { authorization: 's3cret-token' })).status).toBe(401);
      expect((await post(port, '{}', {})).status).toBe(401);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom', () => {
    it('uses the verifier (sync or async) with the request and raw body', async () => {
      const verify = vi.fn(async (req: http.IncomingMessage, raw: Buffer) => req.headers['x-key'] === 'k' && raw.toString() === 'raw!');
      const port = await start({ auth: { type: 'custom', verify } });
      expect((await post(port, 'raw!', { 'x-key': 'k' })).status).toBe(200);
      expect((await post(port, 'raw!', { 'x-key': 'bad' })).status).toBe(401);
    });

    it('treats a throwing verifier as a rejection', async () => {
      const port = await start({
        auth: {
          type: 'custom',
          verify: () => {
            throw new Error('db down with secret=hunter2');
          },
        },
      });
      const res = await post(port, '{}', {});
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('hunter2');
    });
  });

  describe('401 response and logging', () => {
    it('is generic: no reason, no expected signature', async () => {
      const logger = makeLogger();
      const port = await start({ auth: { type: 'hmac', secret: SECRET }, logger });
      const body = '{}';
      const bad = sign(body, 'other');
      const res = await post(port, body, { 'x-signature-256': bad });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.text)).toEqual({ error: 'Unauthorized' });
      expect(res.text).not.toContain(sign(body));
      expect(res.text).not.toContain(bad);
    });

    it('logs failures through the logger without secrets or signatures', async () => {
      const logger = makeLogger();
      const port = await start({ auth: { type: 'hmac', secret: SECRET }, logger });
      const bad = sign('{}', 'other');
      await post(port, '{}', { 'x-signature-256': bad });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(bad);
      expect(logged).not.toContain(sign('{}'));
    });
  });

  describe('configuration', () => {
    it('rejects empty secrets/tokens and toleranceSeconds without timestampHeader', () => {
      expect(() => new WebhookTriggerAdapter({ auth: { type: 'hmac', secret: '' } })).toThrow(/secret/);
      expect(() => new WebhookTriggerAdapter({ auth: { type: 'bearer', token: '' } })).toThrow(/token/);
      expect(() => new WebhookTriggerAdapter({ auth: { type: 'hmac', secret: 's', toleranceSeconds: 5 } })).toThrow(
        /timestampHeader/
      );
      expect(() => new WebhookTriggerAdapter({ auth: { type: 'nope' } as never })).toThrow(/auth\.type/);
    });

    it('warns once when listening on a non-loopback host without auth', async () => {
      const logger = makeLogger();
      const adapter = new WebhookTriggerAdapter({ host: '0.0.0.0', logger });
      const first = adapter.listen(noopAgent, onEvent);
      const second = adapter.listen(noopAgent, onEvent);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0][0])).toContain('auth');
      await Promise.all([waitForPort(first), waitForPort(second)]);
      await Promise.all([first.stop(), second.stop()]);
    });

    it('does not warn on loopback hosts or when auth is configured', async () => {
      const logger = makeLogger();
      const a = new WebhookTriggerAdapter({ host: '127.0.0.1', logger }).listen(noopAgent, onEvent);
      const b = new WebhookTriggerAdapter({ host: '0.0.0.0', logger, auth: { type: 'bearer', token: 't' } }).listen(noopAgent, onEvent);
      expect(logger.warn).not.toHaveBeenCalled();
      await Promise.all([waitForPort(a), waitForPort(b)]);
      await Promise.all([a.stop(), b.stop()]);
    });
  });
});
