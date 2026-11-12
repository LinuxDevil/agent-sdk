/**
 * `s` cut to `max` chars with an ellipsis when it runs over - the pass
 * reply schemas' shared truncation primitive (a long model reply is
 * still a usable one: over-long fields clip, never reject).
 */
export const clip =
  (max: number) =>
  (s: string): string =>
    s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
