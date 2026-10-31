/**
 * The reporter factory shared by the playground and builder runs: an env
 * reporter (`LOUSHO_OBSERVE`) wins so a run is not reported twice, and
 * content is captured only for a loopback target.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { observeExporterFromEnv, type ObserveReporter } from 'lousho/traces';
import { isLoopbackUrl, observeReporting } from '../observeReporting';

const noFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
const overrides = (url: string) => ({ url, fetchFn: noFetch, registerExitHooks: false });

describe('observeReporting', () => {
  const saved = process.env.LOUSHO_OBSERVE;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOUSHO_OBSERVE;
    else process.env.LOUSHO_OBSERVE = saved;
  });

  it('knows a loopback URL', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7777')).toBe(true);
    expect(isLoopbackUrl('http://localhost:7777')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:7777')).toBe(true);
    expect(isLoopbackUrl('http://observe.internal:7777')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  it('captures content only for a loopback target', () => {
    const local = observeReporting({ agentName: 'a', baseDir: process.cwd(), overrides: overrides('http://127.0.0.1:7998') });
    const remote = observeReporting({ agentName: 'a', baseDir: process.cwd(), overrides: overrides('http://observe.internal:7777') });
    expect(local.captureContent()).toBe(true);
    expect(remote.captureContent()).toBe(false);
  });

  it('makes one reporter per agent name, on first use', async () => {
    const reporting = observeReporting({ agentName: 'once', baseDir: process.cwd(), overrides: overrides('http://127.0.0.1:7998') });
    const first = reporting.exporter() as ObserveReporter;
    expect(reporting.exporter()).toBe(first);
    expect(first.agentId).toBeTruthy();
    await first.close();
  });

  it('uses the LOUSHO_OBSERVE reporter when set, so nothing is reported twice', async () => {
    // A closed loopback port: the env reporter drops-and-counts, nothing real is reached.
    process.env.LOUSHO_OBSERVE = 'http://127.0.0.1:1';
    const reporting = observeReporting({ agentName: 'env-wins', baseDir: process.cwd() });
    const fromEnv = observeExporterFromEnv({ agentName: 'env-wins' }) as ObserveReporter;
    expect(reporting.exporter()).toBe(fromEnv);
    expect(reporting.captureContent()).toBe(true);
    await fromEnv.close();
  });
});
