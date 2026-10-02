/**
 * Minimal semver range check for `lousho doctor` (the SDK has no `semver`
 * dependency). Supports the range forms this package's own `engines` and
 * `peerDependencies` use: `>=x.y.z`, `^x.y.z`, `~x.y.z`, exact versions and
 * `||` alternatives. A range it cannot parse is treated as satisfied rather
 * than reported as a false failure.
 */

type Triple = [number, number, number];

function parseTriple(text: string): Triple | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Exclusive upper bound of a caret range: `^1.2.3` < 2.0.0, `^0.2.3` < 0.3.0, `^0.0.3` < 0.0.4. */
function caretCeiling([major, minor, patch]: Triple): Triple {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

function inRange(version: Triple, floor: Triple, ceiling: Triple): boolean {
  return compare(version, floor) >= 0 && compare(version, ceiling) < 0;
}

function satisfiesComparator(version: Triple, comparator: string): boolean {
  const text = comparator.trim();
  if (text.startsWith('>=')) {
    const floor = parseTriple(text.slice(2));
    return floor === null || compare(version, floor) >= 0;
  }
  const operator = text[0];
  const base = parseTriple(operator === '^' || operator === '~' ? text.slice(1) : text);
  if (base === null) return true;
  if (operator === '^') return inRange(version, base, caretCeiling(base));
  if (operator === '~') return inRange(version, base, [base[0], base[1] + 1, 0]);
  return compare(version, base) === 0;
}

/** True when `version` (e.g. "22.19.0" or "v22.19.0") satisfies `range` (e.g. ">=22.19.0"). */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseTriple(version);
  if (parsed === null) return false;
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .every((part) => satisfiesComparator(parsed, part))
  );
}
