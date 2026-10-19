/**
 * createFsTools: file system tools over any FsProvider.
 */
import { z } from 'zod';
import { defineTool, type DefinedTool } from '../defineTool';
import type { FsProvider } from './types';
import { assertResolvedPathAllowed, createDenyTest, type DeniedSegment } from './paths';
import { allowedPath, editFile, globFiles, grepFiles, listDirectory, prepareEdit, readNumberedLines, type FsLimits } from './fsOperations';
import { ConfigurationError } from '../../execution/errors';
import type { WorkspaceCheckpoints } from './checkpoints';
import type { StandardSchemaV1 } from '../../utils/zodCompat';

const pathField = z.string().describe('Path relative to the workspace root, e.g. "src/index.ts".');

const readFileInput = z.object({
  path: pathField,
  offset: z.number().int().min(1).optional().describe('1-based line number to start reading from. Defaults to 1.'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to return.'),
});
const writeFileInput = z.object({
  path: pathField,
  content: z.string().describe('The complete new file content.'),
});
const editFileInput = z.object({
  path: pathField,
  old_string: z.string().describe('Exact text to replace, copied from read_file output without the line-number prefix.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring old_string to be unique.'),
});
const listDirInput = z.object({
  path: z.string().optional().describe('Directory relative to the workspace root. Defaults to the root.'),
});
const globInput = z.object({
  pattern: z.string().describe('Glob such as "**/*.ts" or "src/*.{js,jsx}". "*" stays within one directory; "**" crosses directories.'),
  path: z.string().optional().describe('Directory to search from (the pattern is relative to it). Defaults to the root.'),
});
const grepInput = z.object({
  pattern: z.string().describe('JavaScript regular expression to search for, e.g. "function\\s+main".'),
  path: z.string().optional().describe('File or directory to search. Defaults to the root.'),
  glob: z.string().optional().describe('Only search files matching this glob (relative to path), e.g. "**/*.ts".'),
  ignore_case: z.boolean().optional().describe('Case-insensitive search.'),
});

/**
 * The (parsed) arguments of each file system tool, keyed by tool name.
 * Spelled out rather than inferred from the schemas, so the published
 * declarations name no zod-major-specific types; the `satisfies` checks
 * below keep the two in step.
 */
export interface FsToolArgs {
  read_file: { path: string; offset?: number; limit?: number };
  write_file: { path: string; content: string };
  edit_file: { path: string; old_string: string; new_string: string; replace_all?: boolean };
  list_dir: { path?: string };
  glob: { pattern: string; path?: string };
  grep: { pattern: string; path?: string; glob?: string; ignore_case?: boolean };
}

readFileInput satisfies StandardSchemaV1<FsToolArgs['read_file']>;
writeFileInput satisfies StandardSchemaV1<FsToolArgs['write_file']>;
editFileInput satisfies StandardSchemaV1<FsToolArgs['edit_file']>;
listDirInput satisfies StandardSchemaV1<FsToolArgs['list_dir']>;
globInput satisfies StandardSchemaV1<FsToolArgs['glob']>;
grepInput satisfies StandardSchemaV1<FsToolArgs['grep']>;

/** Name of a tool created by {@link createFsTools}. */
export type FsToolName = keyof FsToolArgs;

/** Per-tool `needsApproval` settings: a boolean, or a predicate over that tool's arguments. */
export type FsToolApprovals = {
  [K in FsToolName]?: boolean | ((args: FsToolArgs[K]) => boolean | Promise<boolean>);
};

/** Options for {@link createFsTools}. */
export interface FsToolsOptions {
  /** Only create the read-only tools (`read_file`, `list_dir`, `glob`, `grep`). Defaults to false. */
  readOnly?: boolean;
  /**
   * Require human approval per tool. None of the tools needs approval by default.
   * @example { write_file: true, edit_file: ({ path }) => path.startsWith('src/') === false }
   */
  needsApproval?: FsToolApprovals;
  /** Most lines `read_file` returns per call. Defaults to 2000. */
  maxReadLines?: number;
  /** Most characters `read_file`, `glob`, `grep` and `list_dir` return per call (roughly). Defaults to 50,000. */
  maxOutputChars?: number;
  /** Most paths/matches/entries `glob`, `grep` and `list_dir` return. Defaults to 200. */
  maxResults?: number;
  /** Most files a `glob`/`grep` walk visits before stopping. Defaults to 20,000. */
  maxFilesScanned?: number;
  /**
   * Milliseconds `grep` may spend matching its regex over all files (time
   * reading files does not count), so a slow pattern cannot hang the run.
   * Defaults to 10,000.
   */
  grepTimeoutMs?: number;
  /** Directory names `glob` and `grep` never descend into. Defaults to `['.git', 'node_modules']`. */
  ignore?: readonly string[];
  /**
   * Entry names no tool opens, lists, searches or writes, at any depth.
   * Defaults to `['.git', '.env', '.env.*']`: `.git/config` can hold a CI
   * checkout token (`http.<url>.extraheader = AUTHORIZATION: basic ...`), a
   * worktree's `.git` file names a host path, and `.env` files hold secrets.
   * An entry ending in `*` is a prefix: `.env.*` covers `.env.local` and
   * `.env.production` but never `.env.example`, `.env.sample` or `.env.template`.
   * A `deny` you pass replaces the defaults, so list `.git` and `.env` again. A path with a denied segment (`.git/config`,
   * `./.GIT`, `a/../.git/`, `sub\.git\HEAD`) is a `WorkspaceError`; `glob`,
   * `grep` and `list_dir` leave such entries out. With a provider that has
   * `realPath` (`NodeWorkspace`), a path that resolves through a symlink or
   * junction to a denied entry (`gitj/config` with `gitj -> .git`) is refused
   * too, for reads, writes and edits alike. Names compare
   * case-insensitively. Pass `[]` to allow everything. The `shell` tool is not
   * covered: a command can still run `cat .git/config`.
   */
  deny?: readonly string[];
  /**
   * Back up every file `write_file` and `edit_file` change, so
   * `checkpoints.rewind(turn)` can put it back. Without it the tools do
   * no extra reads before writing.
   */
  checkpoints?: WorkspaceCheckpoints;
}

function resolveLimits(options: FsToolsOptions): FsLimits {
  return {
    maxReadLines: options.maxReadLines ?? 2000,
    maxOutputChars: options.maxOutputChars ?? 50_000,
    maxResults: options.maxResults ?? 200,
    maxFilesScanned: options.maxFilesScanned ?? 20_000,
    ignore: new Set(options.ignore ?? ['.git', 'node_modules']),
    grepTimeoutMs: options.grepTimeoutMs,
    isDenied: createDenyTest(resolveDeny(options.deny)),
  };
}

function resolveDeny(deny: readonly string[] | undefined): readonly string[] {
  if (deny === undefined) return ['.git', '.env', '.env.*'];
  for (const name of deny) {
    if (typeof name !== 'string' || /[/\\]/.test(name)) {
      throw new ConfigurationError(
        `createFsTools: deny entries are entry names such as ".git", not paths; got ${JSON.stringify(name)}.`,
        'deny'
      );
    }
  }
  return deny;
}

/** A provider whose every path is also checked where it really leads, and that check on its own. */
interface LinkGuard {
  fs: FsProvider;
  /** Rejects when `path` resolves through a link to a denied entry. */
  check(path: string): Promise<void>;
}

/**
 * `fs` with each path also checked against the deny list where it really
 * leads: the lexical check sees `gitj/config`, but a symlink or junction
 * `gitj -> .git` makes that `.git/config`. Only a provider with `realPath`
 * (one that has links) needs it; `fs` itself is used otherwise, or when
 * nothing is denied.
 */
function guardLinks(fs: FsProvider, isDenied: DeniedSegment, denyNames: readonly string[]): LinkGuard {
  const realPath = fs.realPath?.bind(fs);
  if (!realPath || denyNames.length === 0) return { fs, check: async () => undefined };
  const check = async (path: string) => assertResolvedPathAllowed(path, await realPath(path), isDenied);
  const guard =
    <A extends unknown[], R>(op: (path: string, ...rest: A) => Promise<R>) =>
    async (path: string, ...rest: A): Promise<R> => {
      await check(path);
      return op.call(fs, path, ...rest);
    };
  const guarded: FsProvider = {
    readFile: guard(fs.readFile),
    writeFile: guard(fs.writeFile),
    stat: guard(fs.stat),
    readdir: guard(fs.readdir),
    mkdir: guard(fs.mkdir),
    rm: guard(fs.rm),
    glob: fs.glob?.bind(fs),
    getMode: fs.getMode && guard(fs.getMode),
    chmod: fs.chmod && guard(fs.chmod),
    readFileBytes: fs.readFileBytes && guard(fs.readFileBytes),
    realPath,
  };
  return { fs: guarded, check };
}

/** Caps a tool's text output at `maxOutputChars`, saying so. */
function capChars(text: string, limits: FsLimits): string {
  if (text.length <= limits.maxOutputChars) return text;
  return `${text.slice(0, limits.maxOutputChars)}\n[Output truncated at ${limits.maxOutputChars} characters.]`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

function readOnlyTools(fs: FsProvider, limits: FsLimits, approvals: FsToolApprovals): DefinedTool[] {
  return [
    defineTool({
      name: 'read_file',
      annotations: READ_ONLY,
      description:
        'Read a text file from the workspace. Returns numbered lines ("   12\\tcode"); use offset/limit to page through long files.',
      input: readFileInput,
      needsApproval: approvals.read_file,
      execute: (args) => readNumberedLines(fs, args, limits),
    }),
    defineTool({
      name: 'list_dir',
      annotations: READ_ONLY,
      description: 'List a directory in the workspace. Subdirectories end with "/".',
      input: listDirInput,
      needsApproval: approvals.list_dir,
      execute: async (args) => capChars(await listDirectory(fs, args, limits), limits),
    }),
    defineTool({
      name: 'glob',
      annotations: READ_ONLY,
      description: 'Find files by glob pattern. Returns matching workspace-relative paths, sorted.',
      input: globInput,
      needsApproval: approvals.glob,
      execute: async (args, ctx) => capChars(await globFiles(fs, args, limits, ctx?.abortSignal), limits),
    }),
    defineTool({
      name: 'grep',
      annotations: READ_ONLY,
      description: 'Search file contents with a regular expression. Returns "path:line: text" for each matching line.',
      input: grepInput,
      needsApproval: approvals.grep,
      execute: async (args, ctx) => capChars(await grepFiles(fs, args, limits, ctx?.abortSignal), limits),
    }),
  ];
}

function mutatingTools(links: LinkGuard, limits: FsLimits, approvals: FsToolApprovals, checkpoints: WorkspaceCheckpoints | undefined): DefinedTool[] {
  const fs = links.fs;
  return [
    defineTool({
      name: 'write_file',
      editsFiles: true,
      description: 'Create or overwrite a file with the given content. Missing parent directories are created.',
      input: writeFileInput,
      needsApproval: approvals.write_file,
      async execute({ path, content }, ctx) {
        const target = allowedPath(path, limits);
        // Before `track`, which would read the old content into a backup.
        await links.check(target);
        if (checkpoints) await checkpoints.track(ctx, target, { prepare: async () => content, write: (text) => fs.writeFile(target, text) });
        else await fs.writeFile(target, content);
        return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${target}.`;
      },
    }),
    defineTool({
      name: 'edit_file',
      editsFiles: true,
      description:
        'Replace exact text in a file. old_string must match the file exactly (whitespace included) and be unique, unless replace_all is true. Read the file first.',
      input: editFileInput,
      needsApproval: approvals.edit_file,
      async execute(args, ctx) {
        const target = allowedPath(args.path, limits);
        await links.check(target);
        if (!checkpoints) return editFile(fs, args);
        let message = '';
        await checkpoints.track(ctx, target, {
          async prepare() {
            const edit = await prepareEdit(fs, args);
            message = edit.message;
            return edit.content;
          },
          write: (text) => fs.writeFile(target, text),
        });
        return message;
      },
    }),
  ];
}

/**
 * Create file system tools - `read_file`, `write_file`, `edit_file`,
 * `list_dir`, `glob` and `grep` - over any {@link FsProvider}.
 *
 * Paths are workspace-relative; a path that escapes the workspace, a missing
 * file or an ambiguous edit becomes a tool error the model can read and
 * recover from, never an exception that ends the run. Paths through `.git`
 * are refused the same way (see {@link FsToolsOptions.deny}). Outputs are capped and
 * say when they were truncated.
 *
 * @example
 * ```ts
 * import { createAgent, createFsTools, MemoryWorkspace } from '@lousho/build-ai-agent';
 * import { mockModel } from '@lousho/build-ai-agent/testing';
 * const workspace = new MemoryWorkspace({ files: { 'notes.md': '# Notes\n' } });
 * const agent = createAgent({
 *   instructions: 'You edit files in the workspace.',
 *   provider: mockModel(['Done.']),
 *   tools: createFsTools(workspace, { needsApproval: { write_file: true } }),
 * });
 * ```
 */
export function createFsTools(fs: FsProvider, options: FsToolsOptions = {}): DefinedTool[] {
  const limits = resolveLimits(options);
  const links = guardLinks(fs, limits.isDenied ?? (() => undefined), resolveDeny(options.deny));
  const approvals = options.needsApproval ?? {};
  const tools = readOnlyTools(links.fs, limits, approvals);
  return options.readOnly ? tools : [tools[0], ...mutatingTools(links, limits, approvals, options.checkpoints), ...tools.slice(1)];
}
