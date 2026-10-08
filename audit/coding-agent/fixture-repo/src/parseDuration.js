/**
 * Parse a duration such as "250ms", "1.5s", "2m" or "1h" into milliseconds.
 * Throws on anything else.
 */
const UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 100,
  h: 60 * 60 * 1000,
};

export function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(text).trim());
  if (!match) throw new Error(`Invalid duration: ${text}`);
  return Number(match[1]) * UNITS[match[2]];
}
