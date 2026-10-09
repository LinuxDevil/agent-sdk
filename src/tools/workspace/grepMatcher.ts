/**
 * Eve TOOLS-F6: the `grep` tool runs a regex the model wrote. A pattern that
 * backtracks catastrophically (`^(a+)+$`) would block the event loop for
 * seconds or forever, and an abort could not stop it. So the pattern is
 * checked for nested unbounded quantifiers, each line is tested on at most
 * {@link MAX_GREP_TEST_CHARS} characters, and the matching runs in a worker
 * thread that is terminated on timeout or abort. Where `node:worker_threads`
 * is unavailable it falls back to matching inline.
 */
import { WorkspaceError } from './paths';

/** Characters of each line the regex is tested against. */
export const MAX_GREP_TEST_CHARS = 2000;
/** Default wall-clock budget for one `grep` call's matching. */
export const GREP_TIMEOUT_MS = 10_000;

/**
 * Whether `pattern` puts an unbounded quantifier (`*`, `+`, `{n,}`) on a group
 * that itself contains one, as in `(a+)+`, `(\w+\s*)*` or `((ab)*c)+`: the
 * classic shape of catastrophic backtracking.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  /** Per open group: whether it contains an unbounded quantifier. */
  const groups: boolean[] = [];
  /** The atom just before is a group that contains an unbounded quantifier. */
  let afterRiskyGroup = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      afterRiskyGroup = false;
    } else if (c === '[') {
      i++;
      if (pattern[i] === '^') i++;
      if (pattern[i] === ']') i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      afterRiskyGroup = false;
    } else if (c === '(') {
      groups.push(false);
      afterRiskyGroup = false;
    } else if (c === ')') {
      const risky = groups.pop() ?? false;
      if (risky && groups.length > 0) groups[groups.length - 1] = true;
      afterRiskyGroup = risky;
    } else if (c === '*' || c === '+' || (c === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) {
      if (afterRiskyGroup) return true;
      if (groups.length > 0) groups[groups.length - 1] = true;
      if (c === '{') i = pattern.indexOf('}', i);
      if (pattern[i + 1] === '?' || pattern[i + 1] === '+') i++;
      afterRiskyGroup = false;
    } else {
      afterRiskyGroup = false;
    }
  }
  return false;
}

/** Throws a WorkspaceError for a pattern with nested unbounded quantifiers. */
export function assertSafePattern(pattern: string): void {
  if (!hasNestedQuantifier(pattern)) return;
  throw new WorkspaceError(
    `The pattern ${JSON.stringify(pattern)} repeats a group that already repeats (like (a+)+), which can take ` +
      'exponential time. Drop the outer repetition or make the inner one fixed, e.g. (a+) or (?:\\w+ )+ -> \\w+( \\w+)*.'
  );
}

/** Matches lines of one file at a time; `close()` releases it. */
export interface LineMatcher {
  /** 1-based numbers of the lines that match, at most `max`. */
  match(content: string, max: number): Promise<number[]>;
  close(): void;
}

function splitForMatch(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function matchInline(regex: RegExp, content: string, max: number): number[] {
  const hits: number[] = [];
  const lines = splitForMatch(content);
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const line = lines[i];
    if (regex.test(line.length > MAX_GREP_TEST_CHARS ? line.slice(0, MAX_GREP_TEST_CHARS) : line)) hits.push(i + 1);
  }
  return hits;
}

/** The worker: compiles the regex once and answers one `{ content, max }` message per file. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const regex = new RegExp(workerData.source, workerData.flags);
const cap = workerData.cap;
parentPort.on('message', ({ content, max }) => {
  const lines = content.split(/\\r?\\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const line = lines[i];
    if (regex.test(line.length > cap ? line.slice(0, cap) : line)) hits.push(i + 1);
  }
  parentPort.postMessage(hits);
});
`;

type WorkerLike = {
  postMessage(value: unknown): void;
  once(event: 'message' | 'error' | 'exit', listener: (value: never) => void): unknown;
  off(event: 'message' | 'error' | 'exit', listener: (value: never) => void): unknown;
  terminate(): Promise<number>;
  unref(): void;
};
type WorkerCtor = new (source: string, options: { eval: true; workerData: unknown }) => WorkerLike;

async function loadWorker(): Promise<WorkerCtor | undefined> {
  try {
    const threads = (await import('node:worker_threads')) as unknown as { Worker?: WorkerCtor };
    return threads.Worker;
  } catch {
    return undefined;
  }
}

/**
 * A matcher for `regex` with a wall-clock budget of `timeoutMs` over all
 * files. A timeout or an abort terminates the worker and rejects with a
 * WorkspaceError.
 */
export async function createLineMatcher(regex: RegExp, timeoutMs: number, signal?: AbortSignal): Promise<LineMatcher> {
  const Worker = await loadWorker();
  if (!Worker) {
    return { match: async (content, max) => matchInline(regex, content, max), close: () => undefined };
  }
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { source: regex.source, flags: regex.flags, cap: MAX_GREP_TEST_CHARS } });
  worker.unref();
  const deadline = Date.now() + timeoutMs;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    void worker.terminate();
  };
  const match = (content: string, max: number): Promise<number[]> =>
    new Promise<number[]>((resolve, reject) => {
      const finish = (error?: Error, hits?: number[]): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.off('message', onMessage);
        worker.off('error', onError);
        if (error) {
          close();
          reject(error);
        } else resolve(hits ?? []);
      };
      const onMessage = (hits: number[]): void => finish(undefined, hits);
      const onError = (error: Error): void => finish(new WorkspaceError(`grep failed: ${error.message}`));
      const onAbort = (): void => finish(new WorkspaceError('The operation was cancelled.'));
      const timer = setTimeout(
        () =>
          finish(
            new WorkspaceError(
              `grep stopped after ${Math.round(timeoutMs / 1000)}s: the pattern is too slow on this input ` +
                '(it may backtrack heavily). Simplify it, or narrow the path or glob.'
            )
          ),
        Math.max(0, deadline - Date.now())
      );
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', onMessage);
      worker.once('error', onError);
      worker.postMessage({ content, max });
    });
  return { match, close };
}
