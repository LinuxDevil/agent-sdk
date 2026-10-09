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

/**
 * `source` (a prefix of a JSON text) completed into JSON text, or undefined
 * when it holds no complete value yet or is not JSON at all.
 */
export function completePartialJson(source: string): string | undefined {
  const stack: Frame[] = [];
  let cut = -1;
  let cutClosers = '';
  let rootDone = false;
  const mark = (end: number) => {
    cut = end;
    cutClosers = closersOf(stack);
  };
  const valueDone = (end: number) => {
    const top = stack[stack.length - 1];
    if (top) top.expect = 'comma';
    else rootDone = true;
    mark(end);
  };
  let i = 0;
  while (i < source.length && !rootDone) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const top = stack[stack.length - 1];
    const wantsValue = !top || top.expect === 'value';
    if (ch === '"') {
      const end = stringEnd(source, i);
      const isKey = top?.kind === '{' && top.expect === 'key';
      if (!isKey && !wantsValue) return undefined;
      if (end === -1) {
        if (isKey) break;
        // An unfinished string value: keep what arrived, minus a half-written escape.
        return source.slice(0, unfinishedStringEnd(source, i)) + '"' + closersOf(stack);
      }
      i = end + 1;
      if (isKey) top.expect = 'colon';
      else valueDone(i);
      continue;
    }
    if (ch === ':') {
      if (top?.kind !== '{' || top.expect !== 'colon') return undefined;
      top.expect = 'value';
      i++;
      continue;
    }
    if (ch === ',') {
      if (!top || top.expect !== 'comma') return undefined;
      top.expect = top.kind === '{' ? 'key' : 'value';
      i++;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (!wantsValue) return undefined;
      stack.push({ kind: ch, expect: ch === '{' ? 'key' : 'value' });
      i++;
      mark(i);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (!top || (ch === '}') !== (top.kind === '{')) return undefined;
      stack.pop();
      i++;
      valueDone(i);
      continue;
    }
    if (!wantsValue) return undefined;
    let end = i;
    while (end < source.length && !DELIMITER.test(source[end])) end++;
    if (SCALAR.test(source.slice(i, end))) {
      i = end;
      valueDone(i);
      continue;
    }
    // A number or literal still being written ends the usable prefix; anything else is not JSON.
    if (end === source.length) break;
    return undefined;
  }
  return cut === -1 ? undefined : source.slice(0, cut) + cutClosers;
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
