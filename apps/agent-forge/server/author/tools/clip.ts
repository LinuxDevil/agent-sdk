/**
 * `clip`: one hard cap on the text a tool hands the model - `text`
 * cut to `max` chars with `…` marking the cut. runDraft's result text
 * and a trace step's captured args/result share it; full tool output
 * never crosses the tool boundary.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
