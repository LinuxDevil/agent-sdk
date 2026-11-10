/**
 * approvalDeadline.ts's deadline table: the earliest bound that is set
 * (the SDK pause's `expiresAt`, the run's own end at
 * `runStartedAt + maxDurationMs`), DEFAULT_DEADLINE_MS when neither is,
 * and never sooner than `now + MIN_DEADLINE_MS` even when a bound is
 * already past.
 */
import { describe, it, expect } from 'vitest';
import { approvalDeadline, DEFAULT_DEADLINE_MS, MIN_DEADLINE_MS } from '../approvalDeadline';

const NOW = 1_760_000_000_000;
const runStartedAt = NOW - 5_000;

describe('approvalDeadline', () => {
  it.each([
    {
      name: 'no bounds: now + the 15 minute default',
      input: { now: NOW, runStartedAt },
      expectedMs: NOW + DEFAULT_DEADLINE_MS,
    },
    {
      name: 'expiresAt 10 s away: floored to now + 30 s',
      input: { now: NOW, expiresAt: new Date(NOW + 10_000).toISOString(), runStartedAt },
      expectedMs: NOW + MIN_DEADLINE_MS,
    },
    {
      name: 'expiresAt 5 min away, no run limit: the TTL wins',
      input: { now: NOW, expiresAt: new Date(NOW + 5 * 60_000).toISOString(), runStartedAt },
      expectedMs: NOW + 5 * 60_000,
    },
    {
      name: 'run limit earlier than the TTL: the run limit wins',
      input: {
        now: NOW,
        expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
        runStartedAt,
        maxDurationMs: 65_000,
      },
      expectedMs: runStartedAt + 65_000,
    },
    {
      name: 'TTL earlier than the run limit: the TTL wins',
      input: {
        now: NOW,
        expiresAt: new Date(NOW + 60_000).toISOString(),
        runStartedAt,
        maxDurationMs: 10 * 60_000,
      },
      expectedMs: NOW + 60_000,
    },
    {
      name: 'a run limit already past: floored to now + 30 s',
      input: { now: NOW, runStartedAt: NOW - 60_000, maxDurationMs: 30_000 },
      expectedMs: NOW + MIN_DEADLINE_MS,
    },
  ])('$name', ({ input, expectedMs }) => {
    expect(approvalDeadline(input)).toBe(new Date(expectedMs).toISOString());
  });

  it('ignores an unparseable expiresAt and falls back to the default', () => {
    expect(approvalDeadline({ now: NOW, expiresAt: 'not-a-date', runStartedAt })).toBe(
      new Date(NOW + DEFAULT_DEADLINE_MS).toISOString()
    );
  });

  it('minDeadlineMs overrides the floor (RunManager injects it in tests)', () => {
    expect(
      approvalDeadline({ now: NOW, expiresAt: new Date(NOW + 10).toISOString(), runStartedAt, minDeadlineMs: 50 })
    ).toBe(new Date(NOW + 50).toISOString());
  });

  it('minDeadlineMs also replaces the 15 minute default, so a bound-free pause still expires in tests', () => {
    expect(approvalDeadline({ now: NOW, runStartedAt, minDeadlineMs: 50 })).toBe(new Date(NOW + 50).toISOString());
  });
});
