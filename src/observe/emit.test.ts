/**
 * The event post path for non-span emitters: `LOUSHO_OBSERVE` resolves the
 * target exactly like the reporter's env wiring, a batch POSTs once, and a
 * dead daemon drops-and-counts (warning once) instead of throwing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IngestEvent } from './envelope';
import { emitObserveEvent, emitObserveEvents, isLoopbackTarget, observeTargetFromEnv, resetObserveEnvWarning } from './emit';

const score = (id: string): IngestEvent => ({
  type: 'score',
  data: { score_id: id, trace_id: 't1', name: 'eval/acc', value: 1, source: 'eval' },
});

function mockFetch(status = 202): { fetchFn: typeof fetch; calls: { url: string; body: { batch: IngestEvent[] }; headers: Record<string, string> }[] } {
  const calls: { url: string; body: { batch: IngestEvent[] }; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as { batch: IngestEvent[] },
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response('{}', { status });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('observeTargetFromEnv', () => {
  it('is undefined when LOUSHO_OBSERVE is unset, 0 or false', () => {
    expect(observeTargetFromEnv({})).toBeUndefined();
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: '0' })).toBeUndefined();
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: 'false' })).toBeUndefined();
    expect(observeTargetFromEnv(undefined)).toBeUndefined();
  });

  it('maps 1/true to the loopback default (with LOUSHO_OBSERVE_PORT) and a URL through', () => {
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: '1' })?.url).toBe('http://127.0.0.1:7777');
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: 'true', LOUSHO_OBSERVE_PORT: '8899' })?.url).toBe('http://127.0.0.1:8899');
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: 'http://collector.test:1234/' })?.url).toBe('http://collector.test:1234');
  });

  it('carries the token and project', () => {
    const target = observeTargetFromEnv({ LOUSHO_OBSERVE: '1', LOUSHO_OBSERVE_TOKEN: 'lso_x', LOUSHO_OBSERVE_PROJECT: 'p' });
    expect(target).toMatchObject({ token: 'lso_x', project: 'p' });
  });
});

describe('observeTargetFromEnv value parsing', () => {
  it.each(['', '0', 'false', 'FALSE', 'off', 'Off', 'no', 'NO', 'none', 'None', 'disabled', 'DISABLED'])('treats %j as disabled without a warning', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetObserveEnvWarning();
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: value })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(['1', 'true', 'TRUE', 'on', 'On', 'yes', 'YES'])('maps %j to the loopback default', (value) => {
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: value })?.url).toBe('http://127.0.0.1:7777');
  });

  it.each(['http://h:1', 'https://h', 'HTTPS://H.test/'])('passes the URL %j through', (value) => {
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: value })?.url).toBe(value.replace(/\/+$/, ''));
  });

  it('disables and warns ONCE per process on a junk value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetObserveEnvWarning();
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: 'banana' })).toBeUndefined();
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: 'banana' })).toBeUndefined();
    expect(observeTargetFromEnv({ LOUSHO_OBSERVE: 'ftp://x' })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('LOUSHO_OBSERVE');
    expect(String(warn.mock.calls[0][0])).toContain('banana');
    warn.mockRestore();
  });
});

describe('emitObserveEvents', () => {
  it('posts the batch to /api/v1/ingest and resolves the delivered count', async () => {
    const { fetchFn, calls } = mockFetch();
    const delivered = await emitObserveEvents([score('s1'), score('s2')], { env: { LOUSHO_OBSERVE: 'http://d.test:9' }, fetchFn });
    expect(delivered).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://d.test:9/api/v1/ingest');
    expect(calls[0].body.batch.map((e) => e.type)).toEqual(['score', 'score']);
  });

  it('sends the bearer token when the target has one', async () => {
    const { fetchFn, calls } = mockFetch();
    await emitObserveEvent(score('s1'), { env: { LOUSHO_OBSERVE: '1', LOUSHO_OBSERVE_TOKEN: 'lso_abc' }, fetchFn });
    expect(calls[0].headers.authorization).toBe('Bearer lso_abc');
  });

  it('does nothing (and calls no fetch) when LOUSHO_OBSERVE is unset or off', async () => {
    const { fetchFn, calls } = mockFetch();
    expect(await emitObserveEvents([score('s1')], { env: {}, fetchFn })).toBe(0);
    expect(await emitObserveEvents([score('s1')], { env: { LOUSHO_OBSERVE: '0' }, fetchFn })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('drops and counts on a non-2xx answer or a transport failure, warning once, never throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failing = mockFetch(500);
      expect(await emitObserveEvents([score('s1'), score('s2')], { env: { LOUSHO_OBSERVE: '1' }, fetchFn: failing.fetchFn })).toBe(0);
      const throwing = { fetchFn: vi.fn(async () => Promise.reject(new Error('conn refused'))) as unknown as typeof fetch };
      expect(await emitObserveEvents([score('s3')], { env: { LOUSHO_OBSERVE: '1' }, fetchFn: throwing.fetchFn })).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('dropped');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('isLoopbackTarget', () => {
  it.each(['http://127.0.0.1:7777', 'http://localhost:1234', 'http://[::1]:7777', 'https://LOCALHOST'])('%s is loopback', (url) => {
    expect(isLoopbackTarget({ url })).toBe(true);
  });
  it.each(['http://collector.test:7777', 'https://observe.example.com', 'http://0.0.0.0:7777', 'http://localhost.evil.com', 'not a url'])('%s is not', (url) => {
    expect(isLoopbackTarget({ url })).toBe(false);
  });
});
