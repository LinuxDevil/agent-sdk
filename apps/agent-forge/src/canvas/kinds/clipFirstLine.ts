/** The first line of `text`, clipped to 40 characters — a card row value. */
export function clipFirstLine(text: string): string {
  const line = text.split('\n', 1)[0];
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}
