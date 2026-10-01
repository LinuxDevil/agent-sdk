/**
 * Workspace path validation shared by every provider and tool (LOU-X6).
 */

/**
 * A workspace operation was refused or failed (path outside the workspace,
 * file not found, `old_string` not unique, ...). Thrown inside a tool's
 * `execute`, it reaches the model as a tool error
 * (`{ error: 'WorkspaceError', toolName, message }`) instead of aborting the run.
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Windows reserved device names (`CON`, `NUL`, `COM1`, ...), with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function outside(original: string, why: string): WorkspaceError {
  return new WorkspaceError(
    `Path ${JSON.stringify(original)} is outside the workspace (${why}). ` +
      `Use a path relative to the workspace root, e.g. "src/index.ts".`
  );
}

/** Rejects absolute, drive-letter, UNC and NUL-containing paths before any normalization. */
function assertRelativeForm(original: string, unified: string, windows: boolean): void {
  if (original.includes('\0')) throw outside(original, 'it contains a NUL byte');
  if (unified.startsWith('/')) throw outside(original, 'absolute and UNC paths are not allowed');
  if (/^[a-zA-Z]:/.test(unified)) throw outside(original, 'drive-letter paths are not allowed');
  if (windows && unified.includes(':')) {
    throw outside(original, "':' is not allowed in Windows paths (drive letters, alternate data streams)");
  }
}

/** Resolves `.` and `..` segments, refusing any `..` that climbs above the root. */
function collapseSegments(original: string, unified: string, windows: boolean): string[] {
  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) throw outside(original, "'..' climbs above the workspace root");
      out.pop();
      continue;
    }
    if (windows) assertWindowsSegment(original, segment);
    out.push(segment);
  }
  return out;
}

/**
 * Windows silently drops trailing dots and spaces (`'.. '` opens `'..'`), so
 * a segment made only of dots/spaces is refused, as are device names.
 */
function assertWindowsSegment(original: string, segment: string): void {
  const effective = segment.replace(/[ .]+$/, '');
  if (effective === '') {
    throw outside(original, 'segments made only of dots and spaces are not allowed on Windows');
  }
  if (WINDOWS_DEVICE_NAME.test(effective)) {
    throw new WorkspaceError(`Path ${JSON.stringify(original)} names a reserved Windows device and cannot be used.`);
  }
}

/**
 * Normalizes a model-supplied path to a workspace-relative, `/`-separated
 * path (`'.'` for the root), or throws a {@link WorkspaceError}.
 *
 * Rejected on every platform: absolute paths (`/etc/passwd`), UNC paths
 * (`\\server\share`, `//server/share`), drive letters (`C:\`, `C:foo`), NUL
 * bytes and any `..` that climbs above the root. Backslashes are treated as
 * separators everywhere, so mixed separators (`a\..\..\b`) cannot sneak a
 * `..` past the check. On Windows (`platform === 'win32'`) any `:` and the
 * reserved device names (`CON`, `NUL`, ...) are rejected too.
 *
 * This is purely lexical; `NodeWorkspace` additionally resolves symlinks.
 *
 * @example
 * ```ts
 * normalizeWorkspacePath('./src//a/../b.ts'); // 'src/b.ts'
 * normalizeWorkspacePath('../secret');       // throws WorkspaceError
 * ```
 */
export function normalizeWorkspacePath(path: string, platform: string = process.platform): string {
  if (typeof path !== 'string') throw new WorkspaceError('Path must be a string.');
  const windows = platform === 'win32';
  const unified = path.trim().replace(/\\/g, '/');
  assertRelativeForm(path, unified, windows);
  const segments = collapseSegments(path, unified, windows);
  return segments.length === 0 ? '.' : segments.join('/');
}

/** Joins workspace-relative paths (`'.'` is the root). */
export function joinWorkspacePath(base: string, name: string): string {
  return base === '.' ? name : `${base}/${name}`;
}

/** The parent of a normalized workspace path (`'.'` for top-level entries). */
export function parentWorkspacePath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}
