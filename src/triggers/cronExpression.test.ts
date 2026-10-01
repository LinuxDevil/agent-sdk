import { describe, it, expect } from 'vitest';
import { CronExpressionError, parseCronExpression } from './cronExpression';

const next = (expr: string, after: string, tz = 'UTC') =>
  parseCronExpression(expr, tz).nextRun(new Date(after)).toISOString();

describe('parseCronExpression().nextRun()', () => {
  const table: Array<[string, string, string, string?]> = [
    // expression, after, expected, timezone
    ['* * * * *', '2026-01-01T00:00:30Z', '2026-01-01T00:01:00.000Z'],
    ['* * * * *', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00.000Z'],
    ['*/15 * * * *', '2026-01-01T10:07:00Z', '2026-01-01T10:15:00.000Z'],
    ['*/15 * * * *', '2026-01-01T10:45:00Z', '2026-01-01T11:00:00.000Z'],
    ['10-40/10 * * * *', '2026-01-01T12:40:00Z', '2026-01-01T13:10:00.000Z'],
    ['10-40/10 * * * *', '2026-01-01T12:05:00Z', '2026-01-01T12:10:00.000Z'],
    ['5/20 * * * *', '2026-01-01T12:06:00Z', '2026-01-01T12:25:00.000Z'],
    ['0 9 * * MON-FRI', '2026-01-02T09:00:00Z', '2026-01-05T09:00:00.000Z'],
    ['0 9 * * mon-fri', '2026-01-02T08:59:00Z', '2026-01-02T09:00:00.000Z'],
    ['30 4 1,15 * *', '2026-01-15T04:30:00Z', '2026-02-01T04:30:00.000Z'],
    ['0 0 1 JAN *', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00.000Z'],
    ['0 0 1 MAR-MAY *', '2026-05-01T00:00:00Z', '2027-03-01T00:00:00.000Z'],
    ['0 0 31 * *', '2026-01-31T00:00:00Z', '2026-03-31T00:00:00.000Z'],
    ['59 23 31 12 *', '2026-12-31T23:59:00Z', '2027-12-31T23:59:00.000Z'],
    // leap day
    ['0 0 29 2 *', '2026-01-01T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['0 0 29 2 *', '2028-02-29T00:00:00Z', '2032-02-29T00:00:00.000Z'],
    // Sunday as 0, 7 and SUN, and inside a range
    ['0 12 * * 0', '2026-01-01T00:00:00Z', '2026-01-04T12:00:00.000Z'],
    ['0 12 * * 7', '2026-01-01T00:00:00Z', '2026-01-04T12:00:00.000Z'],
    ['0 12 * * SUN', '2026-01-01T00:00:00Z', '2026-01-04T12:00:00.000Z'],
    ['0 12 * * 5-7', '2026-01-03T12:00:00Z', '2026-01-04T12:00:00.000Z'],
    // day-of-month OR day-of-week when both are restricted
    ['0 0 13 * FRI', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00.000Z'],
    ['0 0 13 * FRI', '2026-01-10T00:00:00Z', '2026-01-13T00:00:00.000Z'],
    ['0 0 13 * FRI', '2026-01-13T00:00:00Z', '2026-01-16T00:00:00.000Z'],
    // ...but AND when one of them is a wildcard
    ['0 0 13 * *', '2026-01-01T00:00:00Z', '2026-01-13T00:00:00.000Z'],
    ['0 0 * * MON', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00.000Z'],
    // shortcuts
    ['@hourly', '2026-01-01T10:30:00Z', '2026-01-01T11:00:00.000Z'],
    ['@daily', '2026-01-01T10:30:00Z', '2026-01-02T00:00:00.000Z'],
    ['@weekly', '2026-01-01T10:30:00Z', '2026-01-04T00:00:00.000Z'],
    ['@monthly', '2026-01-01T10:30:00Z', '2026-02-01T00:00:00.000Z'],
    ['  0   0 * *  *  ', '2026-01-01T10:30:00Z', '2026-01-02T00:00:00.000Z'],
    // fixed-offset time zone
    ['0 9 * * *', '2026-01-01T00:00:00Z', '2026-01-01T03:30:00.000Z', 'Asia/Kolkata'],
    // New York spring forward (2026-03-08, 02:00 EST -> 03:00 EDT)
    ['30 1 * * *', '2026-03-07T06:30:00Z', '2026-03-08T06:30:00.000Z', 'America/New_York'],
    ['30 3 * * *', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00.000Z', 'America/New_York'],
    ['0 * * * *', '2026-03-08T06:30:00Z', '2026-03-08T07:00:00.000Z', 'America/New_York'],
    // a time inside the skipped hour does not exist: skipped that day
    ['30 2 * * *', '2026-03-07T07:30:00Z', '2026-03-09T06:30:00.000Z', 'America/New_York'],
    // New York fall back (2026-11-01, 02:00 EDT -> 01:00 EST): fixed times fire once...
    ['30 1 * * *', '2026-11-01T04:00:00Z', '2026-11-01T05:30:00.000Z', 'America/New_York'],
    ['30 1 * * *', '2026-11-01T05:30:00Z', '2026-11-02T06:30:00.000Z', 'America/New_York'],
    // ...while an every-hour schedule keeps its real-time cadence
    ['0 * * * *', '2026-11-01T05:30:00Z', '2026-11-01T06:00:00.000Z', 'America/New_York'],
    ['0 * * * *', '2026-11-01T06:00:00Z', '2026-11-01T07:00:00.000Z', 'America/New_York'],
    // the zone decides the weekday/day, not UTC
    ['0 0 * * MON', '2026-01-01T00:00:00Z', '2026-01-05T05:00:00.000Z', 'America/New_York'],
  ];

  it.each(table)('%s after %s -> %s (%s)', (expr, after, expected, tz) => {
    expect(next(expr, after, tz)).toBe(expected);
  });

  it('is strictly after `after` and successive calls walk forward without repeats', () => {
    const schedule = parseCronExpression('*/20 * * * *', 'UTC');
    let t = new Date('2026-06-01T00:00:00Z');
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      t = schedule.nextRun(t);
      seen.push(t.toISOString());
    }
    expect(seen).toEqual([
      '2026-06-01T00:20:00.000Z',
      '2026-06-01T00:40:00.000Z',
      '2026-06-01T01:00:00.000Z',
      '2026-06-01T01:20:00.000Z',
    ]);
  });

  it('works in the machine local zone when no timezone is given', () => {
    const run = parseCronExpression('* * * * *').nextRun(new Date('2026-01-01T00:00:10Z'));
    expect(run.toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });
});

describe('parseCronExpression() errors', () => {
  const invalid: Array<[string, RegExp]> = [
    ['', /expected 5 space-separated fields/],
    ['* * * *', /expected 5 space-separated fields/],
    ['* * * * * *', /expected 5 space-separated fields/],
    ['@fortnightly', /expected 5 space-separated fields/],
    ['60 * * * *', /minute field "60".*out of range.*0-59.*\*\/15/],
    ['* 24 * * *', /hour field "24".*out of range.*0-23/],
    ['* * 0 * *', /day-of-month field "0".*out of range.*1-31/],
    ['* * * 13 *', /month field "13".*out of range.*1-12/],
    ['* * * * 8', /day-of-week field "8".*out of range.*0-7.*MON-FRI/],
    ['*/0 * * * *', /minute field "\*\/0".*step "0"/],
    ['*/x * * * *', /step "x"/],
    ['5-1 * * * *', /minute field "5-1".*ends before it starts/],
    ['a * * * *', /minute field "a".*not a number/],
    ['* * * FOO *', /month field "FOO".*not a number or name/],
    ['1,,2 * * * *', /minute field.*empty or malformed list item/],
    ['1-2-3 * * * *', /minute field.*malformed range/],
    ['0 0 31 2 *', /never matches/],
  ];

  it.each(invalid)('rejects %j', (expr, message) => {
    expect(() => parseCronExpression(expr)).toThrow(CronExpressionError);
    expect(() => parseCronExpression(expr)).toThrow(message);
  });

  it('rejects an unknown time zone with an example', () => {
    expect(() => parseCronExpression('* * * * *', 'Mars/Olympus')).toThrow(/Invalid timezone "Mars\/Olympus".*America\/New_York/);
  });
});
