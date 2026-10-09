/**
 * Eve CORE-F13: a tolerant parser for JSON that is still being written (a
 * structured-output reply as its text streams). Dependency-free.
 *
 * The prefix is cut back to the last complete value (an unfinished key, a
 * dangling `,` or `:`, a half-written `tru` are dropped), an unfinished
 * string value is kept and closed, and the open objects and arrays are
 * closed. A markdown code fence around the JSON is ignored.
 */

type Frame = { kind: '{' | '['; expect: 'key' | 'colon' | 'value' | 'comma' };

const SCALAR = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;
const DELIMITER = /[\s,\]}:]/;

/** `text` without a leading markdown code fence (and its closing one). */
function withoutFence(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('```')) return text;
  const body = trimmed.slice(trimmed.indexOf('\n') + 1 || trimmed.length);
  const end = body.lastIndexOf('```');
  return end === -1 ? body : body.slice(0, end);
}

/** Where the string starting at `start` (its opening quote) ends: the index of its closing quote, or -1 when unfinished. */
function stringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === '"') return i;
  }
  return -1;
}

/** For an unfinished string starting at `start`: where its usable text ends (before a half-written `\` or `\uXXXX` escape). */
function unfinishedStringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] !== '\\') continue;
    const length = source[i + 1] === 'u' ? 6 : 2;
    if (i + length > source.length) return i;
    i += length - 1;
  }
  return source.length;
}

function closersOf(stack: Frame[]): string {
  return stack
    .map((frame) => (frame.kind === '{' ? '}' : ']'))
    .reverse()
    .join('');
}

/** The scan state of `completePartialJson`: the open frames, the position, and the last place the text can be cut. */
interface Scan {
  readonly source: string;
  readonly stack: Frame[];
  i: number;
  cut: number;
  cutClosers: string;
  rootDone: boolean;
}

/** What one scan step decided: keep going, stop at the last cut, give up (not JSON), or a finished text. */
type Step = 'next' | 'stop' | 'fail' | { done: string };

/** Records `end` as the last place the text can be cut, with the closers for the frames open there. */
function mark(scan: Scan, end: number): void {
  scan.cut = end;
  scan.cutClosers = closersOf(scan.stack);
}

/** A value ended at `end`: its frame now expects a comma (or the root is done). */
function valueDone(scan: Scan, end: number): void {
  const top = scan.stack[scan.stack.length - 1];
  if (top) top.expect = 'comma';
  else scan.rootDone = true;
  mark(scan, end);
}

/** A string (a key or a value) at `scan.i`. */
function scanString(scan: Scan, top: Frame | undefined, wantsValue: boolean): Step {
  const { source, i } = scan;
  const end = stringEnd(source, i);
  const isKey = top?.kind === '{' && top.expect === 'key';
  if (!isKey && !wantsValue) return 'fail';
  if (end === -1) {
    if (isKey) return 'stop';
    // An unfinished string value: keep what arrived, minus a half-written escape.
    return { done: source.slice(0, unfinishedStringEnd(source, i)) + '"' + closersOf(scan.stack) };
  }
  scan.i = end + 1;
  if (isKey) top.expect = 'colon';
  else valueDone(scan, scan.i);
  return 'next';
}

/** A `:` after an object key. */
function scanColon(scan: Scan, top: Frame | undefined): Step {
  if (top?.kind !== '{' || top.expect !== 'colon') return 'fail';
  top.expect = 'value';
  scan.i++;
  return 'next';
}

/** A `,` after a value in an object or array. */
function scanComma(scan: Scan, top: Frame | undefined): Step {
  if (!top || top.expect !== 'comma') return 'fail';
  top.expect = top.kind === '{' ? 'key' : 'value';
  scan.i++;
  return 'next';
}

/** A `{` or `[` opening a value. */
function scanOpen(scan: Scan, ch: '{' | '[', wantsValue: boolean): Step {
  if (!wantsValue) return 'fail';
  scan.stack.push({ kind: ch, expect: ch === '{' ? 'key' : 'value' });
  scan.i++;
  mark(scan, scan.i);
  return 'next';
}

/** A `}` or `]` closing the open frame. */
function scanClose(scan: Scan, ch: string, top: Frame | undefined): Step {
  if (!top || (ch === '}') !== (top.kind === '{')) return 'fail';
  scan.stack.pop();
  scan.i++;
  valueDone(scan, scan.i);
  return 'next';
}

/** A number or literal (`true`, `false`, `null`) at `scan.i`. */
function scanScalar(scan: Scan, wantsValue: boolean): Step {
  if (!wantsValue) return 'fail';
  const { source, i } = scan;
  let end = i;
  while (end < source.length && !DELIMITER.test(source[end])) end++;
  if (SCALAR.test(source.slice(i, end))) {
    scan.i = end;
    valueDone(scan, end);
    return 'next';
  }
  // A number or literal still being written ends the usable prefix; anything else is not JSON.
  return end === source.length ? 'stop' : 'fail';
}

/** One scan step at `ch`, the (non-blank) character at `scan.i`. */
function scanToken(scan: Scan, ch: string): Step {
  const top = scan.stack[scan.stack.length - 1];
  const wantsValue = !top || top.expect === 'value';
  if (ch === '"') return scanString(scan, top, wantsValue);
  if (ch === ':') return scanColon(scan, top);
  if (ch === ',') return scanComma(scan, top);
  if (ch === '{' || ch === '[') return scanOpen(scan, ch, wantsValue);
  if (ch === '}' || ch === ']') return scanClose(scan, ch, top);
  return scanScalar(scan, wantsValue);
}

/**
 * `source` (a prefix of a JSON text) completed into JSON text, or undefined
 * when it holds no complete value yet or is not JSON at all.
 */
function completePartialJson(source: string): string | undefined {
  const scan: Scan = { source, stack: [], i: 0, cut: -1, cutClosers: '', rootDone: false };
  while (scan.i < source.length && !scan.rootDone) {
    const ch = source[scan.i];
    if (/\s/.test(ch)) {
      scan.i++;
      continue;
    }
    const step = scanToken(scan, ch);
    if (step === 'stop') break;
    if (step === 'fail') return undefined;
    if (step !== 'next') return step.done;
  }
  return scan.cut === -1 ? undefined : source.slice(0, scan.cut) + scan.cutClosers;
}

/**
 * Eve CORE-F13: the best-effort value of a JSON text that may be cut off
 * mid-way, or undefined when no part of it parses yet.
 *
 * @example
 * ```ts
 * parsePartialJson('{"title": "Hel');          // { title: 'Hel' }
 * parsePartialJson('{"tags": ["a", "b"], "n');  // { tags: ['a', 'b'] }
 * ```
 */
export function parsePartialJson(text: string): unknown {
  // Not trimEnd(): trailing spaces may be inside an unfinished string.
  const source = withoutFence(text).trimStart();
  if (!source.trim()) return undefined;
  try {
    return JSON.parse(source);
  } catch {
    // Still being written: complete it below.
  }
  const completed = completePartialJson(source);
  if (completed === undefined) return undefined;
  try {
    return JSON.parse(completed);
  } catch {
    return undefined;
  }
}
