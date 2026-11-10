const NUM = '(?:0|[1-9]\\d*)';
const PRE = '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const RANGE = new RegExp(`^(?:${NUM}\\.${NUM}\\.${NUM}${PRE}|[\\^~]${NUM}(?:\\.${NUM}(?:\\.${NUM}${PRE})?)?)$`);

/** True for an exact `x.y.z`, or a caret or tilde range `^x[.y[.z]]` / `~x[.y[.z]]`; anything else (`*`, `>=`, `1.x`, a bare partial version) is false. */
export function isVersionRange(range: string): boolean {
  return RANGE.test(range);
}
