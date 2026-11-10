const NUM = '(?:0|[1-9]\\d*)';
const PRE = '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const RANGE = new RegExp(`^(?:${NUM}\\.${NUM}\\.${NUM}${PRE}|[\\^~]${NUM}(?:\\.${NUM}(?:\\.${NUM}${PRE})?)?)$`);

/** True for an exact `x.y.z`, or a caret or tilde range `^x[.y[.z]]` / `~x[.y[.z]]`; anything else (`*`, `>=`, `1.x`, a bare partial version) is false. */
export function isVersionRange(range: string): boolean {
  return RANGE.test(range);
}

type Parsed = { nums: number[]; pre: string[] };

function parseVersion(text: string): Parsed {
  const [core, ...rest] = text.split('+')[0].split('-');
  const pre = rest.length > 0 ? rest.join('-').split('.') : [];
  return { nums: core.split('.').map(Number), pre };
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareIdentifier(a[i], b[i]);
    if (c !== 0) return c;
  }
  return Math.sign(a.length - b.length);
}

function compareParsed(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return comparePre(a.pre, b.pre);
}

function upperBound(op: string, nums: number[]): number[] {
  const [major, minor = 0, patch = 0] = nums;
  const specified = nums.length;
  if (op === '~') return specified === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
  if (major > 0 || specified === 1) return [major + 1, 0, 0];
  if (minor > 0 || specified === 2) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

function prereleaseAllowed(v: Parsed, base: Parsed): boolean {
  return v.pre.length === 0 || (base.pre.length > 0 && [0, 1, 2].every((i) => v.nums[i] === (base.nums[i] ?? 0)));
}

/** True when `version` (an exact `x.y.z`, optionally with a prerelease) satisfies `range` (exact, `^` or `~`); a prerelease only satisfies a range naming a prerelease on the same `x.y.z`; false for an invalid range. */
export function satisfiesRange(version: string, range: string): boolean {
  if (!isVersionRange(range)) return false;
  const v = parseVersion(version);
  if (v.nums.length !== 3 || v.nums.some(Number.isNaN)) return false;
  const op = range[0] === '^' || range[0] === '~' ? range[0] : '';
  const base = parseVersion(op ? range.slice(1) : range);
  if (!op) return compareParsed(v, base) === 0;
  if (!prereleaseAllowed(v, base)) return false;
  const upper = { nums: upperBound(op, base.nums), pre: [] as string[] };
  return compareParsed(v, base) >= 0 && compareParsed(v, upper) < 0;
}
