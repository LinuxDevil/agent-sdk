/**
 * LOU-P7: `webhookChannel()` authenticates exactly as `WebhookTriggerAdapter`
 * (LOU-D13), which now delegates to it. The cases are D13's test vectors
 * (src/triggers/adapters/WebhookTriggerAdapter.auth.test.ts), run through both.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as http from 'node:http';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAgent } from '../createAgent';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { emptyRunUsage } from '../execution/runUsage';
import { WebhookTriggerAdapter, type WebhookTriggerHandle } from '../triggers/adapters/WebhookTriggerAdapter';
import type { WebhookAuth } from '../triggers/webhookAuth';
import { mountChannels } from './mountChannels';
import { webhookChannel } from './webhookChannel';
import type { Channel } from './defineChannel';
import { defineMemory, inMemoryMemory, type MemoryScopeContext } from '../memory';
import type { RunConfigContext, SimpleAgent } from '../createAgent';

const SECRET = 'whsec_test_secret';
const body = JSON.stringify({ input: 'hello' });
const hmac = (payload: string, secret = SECRET, algorithm: 'sha256' | 'sha1' = 'sha256') => createHmac(algorithm, secret).update(payload).digest('hex');
const nowSeconds = () => String(Math.floor(Date.now() / 1000));

interface Vector {
  name: string;
  auth: WebhookAuth;
  body?: string;
  headers: () => Record<string, string>;
  status: 200 | 401;
}

const hmacAuth: WebhookAuth = { type: 'hmac', secret: SECRET };
const timestamped: WebhookAuth = { type: 'hmac', secret: SECRET, timestampHeader: 'x-timestamp', toleranceSeconds: 60 };
const VECTORS: Vector[] = [
  { name: 'valid signature', auth: hmacAuth, headers: () => ({ 'x-signature-256': `sha256=${hmac(body)}` }), status: 200 },
  { name: 'raw bytes, not re-serialized JSON', auth: hmacAuth, body: '{ "input":   "spaced"  }', headers: () => ({ 'x-signature-256': `sha256=${hmac('{ "input":   "spaced"  }')}` }), status: 200 },
  { name: 'wrong secret', auth: hmacAuth, headers: () => ({ 'x-signature-256': `sha256=${hmac(body, 'wrong-secret')}` }), status: 401 },
  { name: 'missing header', auth: hmacAuth, headers: () => ({}), status: 401 },
  { name: 'short signature', auth: hmacAuth, headers: () => ({ 'x-signature-256': 'sha256=abc' }), status: 401 },
  { name: 'empty signature', auth: hmacAuth, headers: () => ({ 'x-signature-256': 'sha256=' }), status: 401 },
  { name: 'digest without prefix', auth: hmacAuth, headers: () => ({ 'x-signature-256': hmac(body) }), status: 401 },
  { name: 'tampered body', auth: hmacAuth, body: JSON.stringify({ input: 'evil' }), headers: () => ({ 'x-signature-256': `sha256=${hmac(body)}` }), status: 401 },
  { name: 'sha1, custom header', auth: { type: 'hmac', secret: SECRET, header: 'X-Hub-Signature', algorithm: 'sha1' }, headers: () => ({ 'x-hub-signature': `sha1=${hmac(body, SECRET, 'sha1')}` }), status: 200 },
  { name: 'empty prefix', auth: { type: 'hmac', secret: SECRET, prefix: '' }, headers: () => ({ 'x-signature-256': hmac(body) }), status: 200 },
  { name: 'fresh timestamp', auth: timestamped, headers: () => ({ 'x-signature-256': `sha256=${hmac(`${nowSeconds()}.${body}`)}`, 'x-timestamp': nowSeconds() }), status: 200 },
  { name: 'stale timestamp', auth: timestamped, headers: () => { const ts = String(Number(nowSeconds()) - 3600); return { 'x-signature-256': `sha256=${hmac(`${ts}.${body}`)}`, 'x-timestamp': ts }; }, status: 401 },
  { name: 'unsigned timestamp', auth: timestamped, headers: () => ({ 'x-signature-256': `sha256=${hmac(body)}`, 'x-timestamp': nowSeconds() }), status: 401 },
  { name: 'right bearer token', auth: { type: 'bearer', token: 's3cret-token' }, headers: () => ({ authorization: 'Bearer s3cret-token' }), status: 200 },
  { name: 'wrong bearer token', auth: { type: 'bearer', token: 's3cret-token' }, headers: () => ({ authorization: 'Bearer s3cret-tokeX' }), status: 401 },
];

const okResult: ExecutionResult = { text: 'ok', messages: [], toolCalls: [], usage: emptyRunUsage(), finishReason: 'stop', steps: 1 };

/** The status (and parsed body) `mountChannels()` with `channel` answers `payload` with. */
async function viaChannel(channel: Channel, payload: string, headers: Record<string, string>, agent?: Pick<SimpleAgent, 'session' | 'approvals'>) {
  const handler = mountChannels(agent ?? createAgent({ provider: mockModel(['ok']) }), [channel]);
  const req = Object.assign(Readable.from([Buffer.from(payload)]), { method: 'POST', url: '/channels/webhook', headers });
  const res = { status: 0, text: '' };
  const fake = { writeHead: (status: number) => ((res.status = status), fake), end: (text: string) => ((res.text = text), fake) };
  await handler(req as unknown as http.IncomingMessage, fake as unknown as http.ServerResponse);
  return { status: res.status, json: JSON.parse(res.text) as Record<string, unknown> };
}

describe('webhookChannel parity with WebhookTriggerAdapter (LOU-P7, D13 vectors)', () => {
  let handle: WebhookTriggerHandle | undefined;
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  async function viaAdapter(auth: WebhookAuth, payload: string, headers: Record<string, string>) {
    const onEvent = vi.fn(async (_input: string) => okResult);
    handle = new WebhookTriggerAdapter({ host: '127.0.0.1', auth }).listen({ send: vi.fn() }, onEvent);
    await vi.waitFor(() => expect(handle?.port).toBeGreaterThan(0));
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, { method: 'POST', body: payload, headers });
    await handle.stop();
    handle = undefined;
    return { status: res.status, input: onEvent.mock.calls[0]?.[0] };
  }

  for (const vector of VECTORS) {
    it(`${vector.name}: ${vector.status} from both`, async () => {
      const payload = vector.body ?? body;
      const adapter = await viaAdapter(vector.auth, payload, vector.headers());
      const channel = await viaChannel(webhookChannel({ auth: vector.auth }), payload, vector.headers());
      expect(adapter.status).toBe(vector.status);
      expect(channel.status).toBe(vector.status);
      if (vector.status === 401) expect(channel.json).toEqual({ error: 'Unauthorized' });
      else expect(channel.json).toMatchObject({ text: 'ok', finishReason: 'stop' });
      if (vector.status === 200) expect(adapter.input).toBe(JSON.parse(payload).input);
    });
  }

  it('webhookChannel({ secret }) is HMAC-SHA256 over the raw body; config errors match the adapter', async () => {
    const channel = webhookChannel({ secret: SECRET });
    expect((await viaChannel(channel, body, { 'x-signature-256': `sha256=${hmac(body)}` })).status).toBe(200);
    expect((await viaChannel(channel, body, { 'x-signature-256': `sha256=${hmac(body, 'other')}` })).status).toBe(401);
    expect(() => webhookChannel({ secret: '' })).toThrow(/secret/);
    expect(() => new WebhookTriggerAdapter({ auth: { type: 'hmac', secret: '' } })).toThrow(/secret/);
  });

  it('runs the turn with the principal `principal` derives from the verified request (N10a)', async () => {
    const scopes: MemoryScopeContext[] = [];
    const seen: Array<RunConfigContext['principal']> = [];
    const notes = defineMemory({ name: 'notes', scope: (ctx) => (scopes.push(ctx), 'global'), provider: inMemoryMemory() });
    const channel = webhookChannel({
      auth: hmacAuth,
      principal: (body, req) => {
        const source = (body as { source?: unknown } | undefined)?.source;
        return typeof source === 'string' ? { id: source, type: 'service', authenticator: 'webhook', claims: { via: req.headers['x-alert-source'] } } : undefined;
      },
    });
    const agent = createAgent({ provider: mockModel(['ok']), memory: [notes], instructions: ({ principal }: RunConfigContext) => (seen.push(principal), 'x') });

    const payload = JSON.stringify({ input: 'cpu hot', source: 'pagerduty' });
    const res = await viaChannel(channel, payload, { 'x-signature-256': `sha256=${hmac(payload)}`, 'x-alert-source': 'pd-eu' }, agent);

    expect(res.status).toBe(200);
    const principal = { id: 'pagerduty', type: 'service', authenticator: 'webhook', claims: { via: 'pd-eu' } };
    expect(scopes[0]?.principal).toEqual(principal);
    expect(seen).toEqual([principal]);
  });

  it('an approval pause replies with the result and the computed approval prompt text', async () => {
    const restart = defineTool({
      name: 'restart_service',
      description: 'Restarts a service',
      input: z.object({ service: z.string() }),
      needsApproval: true,
      execute: async ({ service }) => `restarted ${service}`,
    });
    const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'restart_service', args: { service: 'checkout' }, id: 'c1' }] }]), tools: [restart] });

    const res = await viaChannel(webhookChannel({}), body, {}, agent);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ finishReason: 'awaiting-approval' });
    expect(res.json.approvalPrompt).toContain('Approve restart_service');
    expect(res.json.approvalPrompt).toContain('checkout');
    expect(res.json.approvalPrompt).toContain(String(res.json.approvalId));
  });

  it('a body without what `principal` needs runs without one', async () => {
    const scopes: MemoryScopeContext[] = [];
    const notes = defineMemory({ name: 'notes', scope: (ctx) => (scopes.push(ctx), 'global'), provider: inMemoryMemory() });
    const channel = webhookChannel({ principal: (body) => ((body as { source?: unknown })?.source === 'x' ? { id: 'x', type: 'service', authenticator: 'webhook' } : undefined) });
    const agent = createAgent({ provider: mockModel(['ok']), memory: [notes] });

    const res = await viaChannel(channel, body, {}, agent);

    expect(res.status).toBe(200);
    expect(scopes[0]?.principal).toBeUndefined();
  });
});
