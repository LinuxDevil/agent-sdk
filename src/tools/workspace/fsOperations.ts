/**
 * The work behind each file system tool (LOU-X6), kept apart from the tool
 * definitions so each piece stays small and testable.
 */
import type { FsProvider } from './types';
import { globToRegExp, walkFiles } from './glob';
import { normalizeWorkspacePath, WorkspaceError } from './paths';
import { assertSafePattern, createLineMatcher, GREP_TIMEOUT_MS } from './grepMatcher';

/** Resolved limits shared by the file system tools. */
export interface FsLimits {
  maxReadLines: number;
  maxOutputChars: number;
  maxResults: number;
  maxFilesScanned: number;
  ignore: ReadonlySet<string>;
  /** Wall-clock budget for one `grep` call's matching (Eve TOOLS-F6); default 10 s. */
  grepTimeoutMs?: number;
}

const MAX_LINE_CHARS = 2000;
const MAX_GREP_LINE_CHARS = 500;
/** Files larger than this are skipped by `grep`. */
const MAX_GREP_FILE_BYTES = 2_000_000;
/** `read_file` refuses files larger than this instead of loading them into memory. */
const MAX_READ_FILE_BYTES = 10_000_000;

function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)} ... [line truncated]` : line;
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isBinary(content: string): boolean {
  return content.includes('\0');
}

/** `read_file`: numbered lines from `offset` (1-based), capped by line count and characters. */
export async function readNumberedLines(
  fs: FsProvider,
  args: { path: string; offset?: number; limit?: number },
  limits: FsLimits
): Promise<string> {
  const path = normalizeWorkspacePath(args.path);
  const stat = await fs.stat(path);
  if (stat && stat.type === 'file' && stat.size > MAX_READ_FILE_BYTES) {
    throw new WorkspaceError(`${path} is too large to read (${stat.size} bytes). Use grep to find the lines you need.`);
  }
  const content = await fs.readFile(path);
  if (isBinary(content)) return `${path} looks like a binary file; read_file only shows text files.`;
  const lines = splitLines(content);
  if (lines.length === 0) return `${path} is empty.`;
  const start = (args.offset ?? 1) - 1;
  if (start >= lines.length) {
    throw new WorkspaceError(`offset ${args.offset} is past the end of ${path}, which has ${lines.length} lines.`);
  }
  const end = Math.min(lines.length, start + Math.min(args.limit ?? limits.maxReadLines, limits.maxReadLines));
  const out: string[] = [];
  let chars = 0;
  let i = start;
  for (; i < end; i++) {
    const numbered = `${String(i + 1).padStart(6)}\t${clip(lines[i], MAX_LINE_CHARS)}`;
    if (out.length > 0 && chars + numbered.length > limits.maxOutputChars) break;
    out.push(numbered);
    chars += numbered.length + 1;
  }
  if (i < lines.length) {
    out.push(`[Truncated: showing lines ${start + 1}-${i} of ${lines.length}. Call read_file with offset=${i + 1} to read more.]`);
  }
  return out.join('\n');
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function notFoundMessage(path: string, content: string, oldString: string): string {
  const crlfHint =
    content.includes('\r\n') && content.replace(/\r\n/g, '\n').includes(oldString.replace(/\r\n/g, '\n'))
      ? ' The file uses CRLF line endings; include them (\\r\\n) in old_string.'
      : '';
  return (
    `old_string was not found in ${path}. Call read_file and copy the exact text, ` +
    `including whitespace and indentation (without the line-number prefix).${crlfHint}`
  );
}

/** The arguments of `edit_file`. */
interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** An `edit_file` call that passed every check: the content to write and the message to return. */
export interface PreparedEdit {
  path: string;
  content: string;
  message: string;
}

/** Reads the file and computes an `edit_file` change without writing it; throws for an edit that would fail. */
export async function prepareEdit(fs: FsProvider, args: EditArgs): Promise<PreparedEdit> {
  const path = normalizeWorkspacePath(args.path);
  if (args.old_string === '') {
    throw new WorkspaceError('old_string must not be empty. To create or overwrite a whole file, use write_file.');
  }
  if (args.old_string === args.new_string) {
    throw new WorkspaceError('old_string and new_string are identical, so there is nothing to change.');
  }
  const content = await fs.readFile(path);
  const count = countOccurrences(content, args.old_string);
  if (count === 0) throw new WorkspaceError(notFoundMessage(path, content, args.old_string));
  if (count > 1 && !args.replace_all) {
    throw new WorkspaceError(
      `old_string appears ${count} times in ${path}. Include more surrounding lines to make it unique, ` +
        'or pass replace_all: true to replace every occurrence.'
    );
  }
  return {
    path,
    content: content.split(args.old_string).join(args.new_string),
    message: `Edited ${path}: replaced ${count} occurrence${count === 1 ? '' : 's'}.`,
  };
}

/** `edit_file`: exact string replacement that refuses ambiguous edits unless `replace_all`. */
export async function editFile(fs: FsProvider, args: EditArgs): Promise<string> {
  const edit = await prepareEdit(fs, args);
  await fs.writeFile(edit.path, edit.content);
  return edit.message;
}

/** `list_dir`: sorted entries, directories suffixed with `/`. */
export async function listDirectory(fs: FsProvider, args: { path?: string }, limits: FsLimits): Promise<string> {
  const path = normalizeWorkspacePath(args.path ?? '.');
  const entries = await fs.readdir(path);
  const names = entries.map((e) => (e.type === 'directory' ? `${e.name}/` : e.name)).sort();
  if (names.length === 0) return `${path} is empty.`;
  const shown = names.slice(0, limits.maxResults);
  if (names.length > shown.length) {
    shown.push(`[Truncated: showing ${shown.length} of ${names.length} entries.]`);
  }
  return shown.join('\n');
}

interface FileList {
  files: string[];
  truncated: boolean;
}

/** Files under `base` matching `pattern` (relative to `base`), via the provider's glob or a walk. */
async function findFiles(
  fs: FsProvider,
  base: string,
  pattern: string | undefined,
  limits: FsLimits,
  signal?: AbortSignal
): Promise<FileList> {
  const normalizedPattern = pattern === undefined ? undefined : normalizeWorkspacePath(pattern);
  if (normalizedPattern !== undefined && fs.glob) {
    const full = base === '.' ? normalizedPattern : `${base}/${normalizedPattern}`;
    const files = (await fs.glob(full, { signal })).map((p) => normalizeWorkspacePath(p));
    return { files: [...new Set(files)].sort(), truncated: false };
  }
  const regex = normalizedPattern === undefined ? undefined : globToRegExp(normalizedPattern);
  const walked = await walkFiles(fs, base, { ignore: limits.ignore, maxFiles: limits.maxFilesScanned, signal });
  const prefix = base === '.' ? 0 : base.length + 1;
  const files = regex ? walked.files.filter((f) => regex.test(f.slice(prefix))) : walked.files;
  return { files: files.sort(), truncated: walked.truncated };
}

function scanNote(truncated: boolean, limits: FsLimits): string {
  return truncated ? `\n[Stopped after scanning ${limits.maxFilesScanned} files; narrow the path or pattern.]` : '';
}

/** `glob`: sorted workspace-relative paths of files matching `pattern`. */
export async function globFiles(
  fs: FsProvider,
  args: { pattern: string; path?: string },
  limits: FsLimits,
  signal?: AbortSignal
): Promise<string> {
  const base = normalizeWorkspacePath(args.path ?? '.');
  const { files, truncated } = await findFiles(fs, base, args.pattern, limits, signal);
  if (files.length === 0) return `No files match ${JSON.stringify(args.pattern)} under ${base}.${scanNote(truncated, limits)}`;
  const shown = files.slice(0, limits.maxResults);
  const more = files.length > shown.length ? `\n[Truncated: showing ${shown.length} of ${files.length} matches.]` : '';
  return shown.join('\n') + more + scanNote(truncated, limits);
}

function compileRegex(pattern: string, ignoreCase: boolean | undefined): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (error) {
    throw new WorkspaceError(
      `Invalid regular expression ${JSON.stringify(pattern)}: ${(error as Error).message}. ` +
        'Use JavaScript RegExp syntax and escape special characters such as ( [ { . * + ?.'
    );
  }
}

/** Files `grep` should search: `path` itself when it is a file, else the (filtered) tree below it. */
async function grepTargets(
  fs: FsProvider,
  args: { path?: string; glob?: string },
  limits: FsLimits,
  signal?: AbortSignal
): Promise<FileList> {
  const base = normalizeWorkspacePath(args.path ?? '.');
  const stat = await fs.stat(base);
  if (!stat) throw new WorkspaceError(`Path not found: ${base}`);
  if (stat.type === 'file') return { files: [base], truncated: false };
  return findFiles(fs, base, args.glob, limits, signal);
}

/** `grep`: regex search over text files, returning `path:line: text`. */
export async function grepFiles(
  fs: FsProvider,
  args: { pattern: string; path?: string; glob?: string; ignore_case?: boolean },
  limits: FsLimits,
  signal?: AbortSignal
): Promise<string> {
  const regex = compileRegex(args.pattern, args.ignore_case);
  assertSafePattern(args.pattern);
  const { files, truncated } = await grepTargets(fs, args, limits, signal);
  const matches: string[] = [];
  let capped = false;
  // The regex runs off the event loop with a timeout, so a slow pattern cannot freeze the process.
  const matcher = await createLineMatcher(regex, limits.grepTimeoutMs ?? GREP_TIMEOUT_MS, signal);
  try {
    for (const file of files) {
      if (signal?.aborted) throw new WorkspaceError('The operation was cancelled.');
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat || stat.size > MAX_GREP_FILE_BYTES) continue;
      const content = await fs.readFile(file).catch(() => '');
      if (isBinary(content)) continue;
      const hits = await matcher.match(content, limits.maxResults - matches.length);
      if (hits.length === 0) continue;
      const lines = splitLines(content);
      for (const line of hits) matches.push(`${file}:${line}: ${clip(lines[line - 1], MAX_GREP_LINE_CHARS)}`);
      if (matches.length >= limits.maxResults) {
        capped = true;
        break;
      }
    }
  } finally {
    matcher.close();
  }
  if (matches.length === 0) return `No matches for ${JSON.stringify(args.pattern)}.${scanNote(truncated, limits)}`;
  const more = capped ? `\n[Truncated at ${limits.maxResults} matches; narrow the pattern, path or glob.]` : '';
  return matches.join('\n') + more + scanNote(truncated, limits);
}
