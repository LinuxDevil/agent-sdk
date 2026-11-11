const NUM = '(?:0|[1-9]\\d*)';
const PRE_BODY = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const PRE = `(?:-${PRE_BODY})?`;
const RANGE = new RegExp(`^(?:${NUM}\\.${NUM}\\.${NUM}${PRE}|[\\^~]${NUM}(?:\\.${NUM}(?:\\.${NUM}${PRE})?)?)$`);
const RANGE_PARTS = new RegExp(`^([\\^~]?)(${NUM})(?:\\.(${NUM})(?:\\.(${NUM})(?:-(${PRE_BODY}))?)?)?$`);
const VERSION = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_BODY}))?$`);

type Triple = [number, number, number];

interface Version {
  core: Triple;
  pre: string[];
}

/** True for an exact `x.y.z`, or a caret or tilde range `^x[.y[.z]]` / `~x[.y[.z]]`; anything else (`*`, `>=`, `1.x`, a bare partial version) is false. */
export function isVersionRange(range: string): boolean {
  return RANGE.test(range);
}

function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') };
}

function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = compareIdentifier(a[index], b[index]);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

function compareCore(a: Triple, b: Triple): number {
  const index = a.findIndex((part, at) => part !== b[at]);
  return index === -1 ? 0 : Math.sign(a[index] - b[index]);
}

function compareParsed(a: Version, b: Version): number {
  return compareCore(a.core, b.core) || comparePre(a.pre, b.pre);
}

/** Orders two exact versions by semver precedence (negative when `a` is lower); an unparseable version sorts below every valid one. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  if (left === undefined || right === undefined) return Math.sign(Number(left !== undefined) - Number(right !== undefined));
  return compareParsed(left, right);
}

function caretCeiling([major, minor, patch]: Triple, given: number): Triple {
  if (major > 0 || given === 1) return [major + 1, 0, 0];
  if (minor > 0 || given === 2) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

function tildeCeiling([major, minor]: Triple, given: number): Triple {
  return given === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
}

function ceilingOf(operator: string, core: Triple, given: number): Triple {
  return operator === '^' ? caretCeiling(core, given) : tildeCeiling(core, given);
}

/** True when the exact version `version` satisfies `range` (the {@link isVersionRange} grammar) with npm semantics: `^0.x` and `~x` bounds as npm sets them, prereleases only when the range names one on the same `x.y.z`; anything unparseable is false. */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const parts = isVersionRange(range) ? RANGE_PARTS.exec(range) : null;
  if (parsed === undefined || parts === null) return false;
  const given = [parts[3], parts[4]].filter((part) => part !== undefined).length + 1;
  const floor: Version = { core: [Number(parts[2]), Number(parts[3] ?? 0), Number(parts[4] ?? 0)], pre: parts[5] === undefined ? [] : parts[5].split('.') };
  if (parsed.pre.length > 0 && (floor.pre.length === 0 || compareCore(parsed.core, floor.core) !== 0)) return false;
  if (parts[1] === '') return compareParsed(parsed, floor) === 0;
  return compareParsed(parsed, floor) >= 0 && compareCore(parsed.core, ceilingOf(parts[1], floor.core, given)) < 0;
}
