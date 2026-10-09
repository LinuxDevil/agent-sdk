/**
 * Dependency-free cron expression parser and scheduler math (LOU-D13).
 *
 * Supports the standard 5-field format `minute hour day-of-month month
 * day-of-week` with `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/15`,
 * `10-40/10`), month names (`JAN`) and weekday names (`MON`), with both `0`
 * and `7` meaning Sunday. When both day-of-month and day-of-week are
 * restricted a day matches if EITHER does (classic Vixie cron semantics).
 * The shortcuts `@hourly`, `@daily`, `@weekly`, `@monthly` (and `@yearly`)
 * are accepted too.
 *
 * Time zones use `Intl.DateTimeFormat` (any IANA name). Around DST changes:
 * a wall-clock time that does not exist (spring forward) is skipped that
 * day; a wall-clock time that happens twice (fall back) fires once if the
 * hour field is restricted, while an every-hour schedule keeps firing
 * hourly in real time.
 */

/** Thrown for an invalid cron expression or time zone; the message names the field and shows a valid example. */
export class CronExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronExpressionError';
  }
}

/** A parsed cron expression. */
export interface CronSchedule {
  /** The first fire time strictly after `after`. */
  nextRun(after: Date): Date;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  example: string;
  names?: readonly string[];
  /** Added to a name's index to get its numeric value. */
  nameOffset?: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59, example: '*/15' },
  { name: 'hour', min: 0, max: 23, example: '9-17' },
  { name: 'day-of-month', min: 1, max: 31, example: '1,15' },
  { name: 'month', min: 1, max: 12, example: 'JAN-JUN', names: MONTHS, nameOffset: 1 },
  { name: 'day-of-week', min: 0, max: 7, example: 'MON-FRI', names: WEEKDAYS, nameOffset: 0 },
];

const SHORTCUTS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const EXAMPLE_EXPRESSION = '"*/15 9-17 * * MON-FRI" or "@daily"';

function fieldError(spec: FieldSpec, text: string, problem: string): CronExpressionError {
  return new CronExpressionError(
    `Invalid cron expression: ${spec.name} field "${text}" ${problem}. ` +
      `Allowed values are ${spec.min}-${spec.max}${spec.names ? ` or names like ${spec.names[0]}` : ''}; e.g. "${spec.example}".`
  );
}

function parseValue(spec: FieldSpec, token: string, whole: string): number {
  const nameIndex = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  const value = nameIndex >= 0 ? nameIndex + (spec.nameOffset ?? 0) : /^\d+$/.test(token) ? Number(token) : NaN;
  if (Number.isNaN(value)) throw fieldError(spec, whole, `has "${token}", which is not a number${spec.names ? ' or name' : ''}`);
  if (value < spec.min || value > spec.max) throw fieldError(spec, whole, `has ${value}, which is out of range`);
  return value;
}

function parseStep(spec: FieldSpec, stepText: string | undefined, whole: string): number {
  if (stepText === undefined) return 1;
  if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
    throw fieldError(spec, whole, `has step "${stepText}", which must be a positive integer`);
  }
  return Number(stepText);
}

function parseRange(spec: FieldSpec, rangeText: string, hasStep: boolean, whole: string): [number, number] {
  if (rangeText === '*') return [spec.min, spec.max];
  const [startText, endText, ...extra] = rangeText.split('-');
  if (extra.length > 0 || startText === '') throw fieldError(spec, whole, `has a malformed range "${rangeText}"`);
  const start = parseValue(spec, startText, whole);
  if (endText !== undefined) {
    const end = parseValue(spec, endText, whole);
    if (end < start) throw fieldError(spec, whole, `has range "${rangeText}" that ends before it starts`);
    return [start, end];
  }
  return [start, hasStep ? spec.max : start];
}

function parseField(spec: FieldSpec, text: string): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [rangeText, stepText, ...extra] = part.split('/');
    if (part === '' || extra.length > 0) throw fieldError(spec, text, 'has an empty or malformed list item');
    const step = parseStep(spec, stepText, text);
    const [start, end] = parseRange(spec, rangeText, stepText !== undefined, text);
    for (let v = start; v <= end; v += step) values.add(spec.name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return values;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function makeFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
  } catch {
    throw new CronExpressionError(
      `Invalid timezone "${timeZone}". Use an IANA name such as "America/New_York" or "UTC".`
    );
  }
}

function zonedParts(formatter: Intl.DateTimeFormat, date: Date): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAY_INDEX[p.weekday],
  };
}

/** The wall-clock fields read as if they were UTC, for offset arithmetic. */
function asUtcMs(p: ZonedParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const MAX_SEARCH_YEARS = 10;

class CronExpressionSchedule implements CronSchedule {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(
    private readonly minutes: Set<number>,
    private readonly hours: Set<number>,
    private readonly daysOfMonth: Set<number>,
    private readonly months: Set<number>,
    private readonly daysOfWeek: Set<number>,
    private readonly flags: { domRestricted: boolean; dowRestricted: boolean; hourRestricted: boolean },
    timeZone: string | undefined
  ) {
    this.formatter = makeFormatter(timeZone);
  }

  private dayMatches(p: ZonedParts): boolean {
    const domMatch = this.daysOfMonth.has(p.day);
    const dowMatch = this.daysOfWeek.has(p.weekday);
    if (this.flags.domRestricted && this.flags.dowRestricted) return domMatch || dowMatch;
    return domMatch && dowMatch;
  }

  /** The earliest instant whose wall clock reads the given local midnight (or just after it if midnight does not exist). */
  private startOfDay(rawYear: number, rawMonth: number, rawDay: number): number {
    const guess = Date.UTC(rawYear, rawMonth - 1, rawDay);
    const target = new Date(guess);
    const [year, month, day] = [target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()];
    for (const offset of [-HOUR_MS * 14, HOUR_MS * 14]) {
      const probe = new Date(guess + offset);
      const candidate = guess - (asUtcMs(zonedParts(this.formatter, probe)) - probe.getTime());
      const p = zonedParts(this.formatter, new Date(candidate));
      if (p.year === year && p.month === month && p.day === day && p.hour === 0 && p.minute === 0) {
        return candidate;
      }
    }
    // Midnight is skipped by a DST change: the first instant of that local day.
    let t = guess - HOUR_MS * 14;
    while (zonedParts(this.formatter, new Date(t)).day !== day) t += 15 * MINUTE_MS;
    return t;
  }

  /** True for the second occurrence of a wall-clock time that happens twice (DST fall back). */
  private isRepeatedHour(t: number, p: ZonedParts): boolean {
    const earlier = zonedParts(this.formatter, new Date(t - HOUR_MS));
    return earlier.hour === p.hour && earlier.day === p.day && earlier.minute === p.minute;
  }

  private nextInSet(set: Set<number>, from: number): number | undefined {
    let best: number | undefined;
    for (const v of set) if (v >= from && (best === undefined || v < best)) best = v;
    return best;
  }

  /** Advance past a non-matching time unit; returns the next instant worth examining. */
  private step(t: number, p: ZonedParts): number {
    if (!this.months.has(p.month)) return this.startOfDay(p.year, p.month + 1, 1);
    if (!this.dayMatches(p)) return this.startOfDay(p.year, p.month, p.day + 1);
    if (!this.hours.has(p.hour)) return t + (60 - p.minute) * MINUTE_MS;
    const next = this.nextInSet(this.minutes, p.minute + 1);
    return t + ((next ?? 60) - p.minute) * MINUTE_MS;
  }

  private matches(t: number, p: ZonedParts): boolean {
    if (!this.months.has(p.month) || !this.dayMatches(p) || !this.hours.has(p.hour) || !this.minutes.has(p.minute)) {
      return false;
    }
    return !(this.flags.hourRestricted && this.isRepeatedHour(t, p));
  }

  /** Day, month, hour and minute fields all match this wall-clock reading (no repeated-hour check: it is a skipped time). */
  private wallMatches(p: ZonedParts): boolean {
    return this.months.has(p.month) && this.dayMatches(p) && this.hours.has(p.hour) && this.minutes.has(p.minute);
  }

  /**
   * True when `t` is the first instant after a spring-forward gap and a
   * fixed-hour job's wall time fell inside the gap: like Vixie cron, it runs
   * once at `t` instead of being skipped for the day (Eve DUR-F20).
   */
  private firesAfterGap(t: number, p: ZonedParts): boolean {
    if (!this.flags.hourRestricted) return false;
    const before = asUtcMs(zonedParts(this.formatter, new Date(t - MINUTE_MS)));
    const now = asUtcMs(p);
    if (now - before <= MINUTE_MS) return false;
    for (let wall = before + MINUTE_MS; wall < now; wall += MINUTE_MS) {
      const d = new Date(wall);
      const skipped = {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        weekday: d.getUTCDay(),
      };
      if (this.wallMatches(skipped)) return true;
    }
    return false;
  }

  public nextRun(after: Date): Date {
    const limit = after.getTime() + MAX_SEARCH_YEARS * 366 * 24 * HOUR_MS;
    let t = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    while (t <= limit) {
      const p = zonedParts(this.formatter, new Date(t));
      if (this.matches(t, p) || this.firesAfterGap(t, p)) return new Date(t);
      t = this.step(t, p);
    }
    throw new CronExpressionError('Cron expression never matches a real date (for example "0 0 31 2 *"). Check the day-of-month and month fields.');
  }
}

/**
 * Parses a cron expression into a schedule.
 *
 * @param expression A 5-field cron expression or one of `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.
 * @param timeZone IANA time zone name (e.g. `'America/New_York'`). Defaults to the machine's local zone.
 * @throws {CronExpressionError} With the offending field and an example of a valid value.
 *
 * @example
 * ```ts
 * const schedule = parseCronExpression('*\/15 9-17 * * MON-FRI', 'Europe/Paris');
 * const next = schedule.nextRun(new Date());
 * ```
 */
export function parseCronExpression(expression: string, timeZone?: string): CronSchedule {
  const trimmed = expression.trim();
  const fields = (SHORTCUTS[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  if (trimmed === '' || fields.length !== FIELDS.length) {
    throw new CronExpressionError(
      `Invalid cron expression "${expression}": expected 5 space-separated fields (minute hour day-of-month month day-of-week) ` +
        `or a shortcut (@hourly, @daily, @weekly, @monthly), e.g. ${EXAMPLE_EXPRESSION}.`
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELDS.map((spec, i) => parseField(spec, fields[i]));
  const schedule = new CronExpressionSchedule(
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    {
      domRestricted: !fields[2].startsWith('*'),
      dowRestricted: !fields[4].startsWith('*'),
      hourRestricted: !fields[1].startsWith('*'),
    },
    timeZone
  );
  schedule.nextRun(new Date(0)); // fail fast on an impossible schedule such as "0 0 31 2 *"
  return schedule;
}
