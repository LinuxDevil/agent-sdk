/**
 * Version free-text fields (`requestText`, PLAN §4): one clamp every
 * write path shares so a version's "why" is always a single-line,
 * bounded string - or `null` when there is nothing to say.
 */

/** `requestText` is stored clamped to this many chars (PLAN §4). */
export const VERSION_REQUEST_MAX_CHARS = 400;

/**
 * `text` collapsed to a single-line, ≤ `max`-char string: whitespace runs
 * become one space, the ends are trimmed, and anything longer is cut to
 * `max - 1` chars plus '…' (`max` includes the ellipsis). `null` when
 * nothing remains (or nothing was given) - version text fields stay
 * nullable rather than empty.
 */
export function clampVersionText(text: string | null | undefined, max: number): string | null {
  const collapsed = text?.replace(/\s+/g, ' ').trim() ?? '';
  if (collapsed === '') return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
