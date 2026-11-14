/**
 * W14: `lousho/observe` is the public surface Studio (and other hosts) use to
 * run and probe the collector — named re-exports of the daemon helpers only.
 */
import { describe, expect, it } from 'vitest';
import * as observe from './index';

describe('lousho/observe', () => {
  it('exports exactly the documented surface', () => {
    expect(Object.keys(observe).sort()).toEqual([
      'OBSERVE_DEFAULT_PORT',
      'OBSERVE_RETENTION_DAYS_DEFAULT',
      'OBSERVE_SESSION_IDLE_MINUTES_DEFAULT',
      'defaultDbPath',
      'isObserveDaemon',
      'probeHealth',
      'startObserveDaemon',
    ]);
  });

  it('starts and closes a daemon on an ephemeral port without touching disk', async () => {
    const daemon = await observe.startObserveDaemon({ dbPath: ':memory:', port: 0, sweepIntervalMs: 0 });
    try {
      expect(daemon.port).toBeGreaterThan(0);
      const health = await observe.probeHealth(daemon.port);
      expect(observe.isObserveDaemon(health)).toBe(true);
    } finally {
      await daemon.close();
    }
  });
});
