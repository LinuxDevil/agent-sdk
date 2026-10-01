/**
 * createFsTools: file system tools over any FsProvider (LOU-X6).
 */
import { z } from 'zod';
import { defineTool, type DefinedTool } from '../defineTool';
import type { FsProvider } from './types';
import { normalizeWorkspacePath } from './paths';
import { editFile, globFiles, grepFiles, listDirectory, readNumberedLines, type FsLimits } from './fsOperations';

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

/** The (parsed) arguments of each file system tool, keyed by tool name. */
export interface FsToolArgs {
  read_file: z.output<typeof readFileInput>;
  write_file: z.output<typeof writeFileInput>;
  edit_file: z.output<typeof editFileInput>;
  list_dir: z.output<typeof listDirInput>;
  glob: z.output<typeof globInput>;
  grep: z.output<typeof grepInput>;
}

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
  /** Directory names `glob` and `grep` never descend into. Defaults to `['.git', 'node_modules']`. */
  ignore?: readonly string[];
}

function resolveLimits(options: FsToolsOptions): FsLimits {
  return {
    maxReadLines: options.maxReadLines ?? 2000,
    maxOutputChars: options.maxOutputChars ?? 50_000,
    maxResults: options.maxResults ?? 200,
    maxFilesScanned: options.maxFilesScanned ?? 20_000,
    ignore: new Set(options.ignore ?? ['.git', 'node_modules']),
  };
}

/** Caps a tool's text output at `maxOutputChars`, saying so. */
function capChars(text: string, limits: FsLimits): string {
  if (text.length <= limits.maxOutputChars) return text;
  return `${text.slice(0, limits.maxOutputChars)}\n[Output truncated at ${limits.maxOutputChars} characters.]`;
}

function readOnlyTools(fs: FsProvider, limits: FsLimits, approvals: FsToolApprovals): DefinedTool[] {
  return [
    defineTool({
      name: 'read_file',
      description:
        'Read a text file from the workspace. Returns numbered lines ("   12\\tcode"); use offset/limit to page through long files.',
      input: readFileInput,
      needsApproval: approvals.read_file,
      execute: (args) => readNumberedLines(fs, args, limits),
    }),
    defineTool({
      name: 'list_dir',
      description: 'List a directory in the workspace. Subdirectories end with "/".',
      input: listDirInput,
      needsApproval: approvals.list_dir,
      execute: async (args) => capChars(await listDirectory(fs, args, limits), limits),
    }),
    defineTool({
      name: 'glob',
      description: 'Find files by glob pattern. Returns matching workspace-relative paths, sorted.',
      input: globInput,
      needsApproval: approvals.glob,
      execute: async (args, ctx) => capChars(await globFiles(fs, args, limits, ctx?.abortSignal), limits),
    }),
    defineTool({
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns "path:line: text" for each matching line.',
      input: grepInput,
      needsApproval: approvals.grep,
      execute: async (args, ctx) => capChars(await grepFiles(fs, args, limits, ctx?.abortSignal), limits),
    }),
  ];
}

function mutatingTools(fs: FsProvider, approvals: FsToolApprovals): DefinedTool[] {
  return [
    defineTool({
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Missing parent directories are created.',
      input: writeFileInput,
      needsApproval: approvals.write_file,
      async execute({ path, content }) {
        const target = normalizeWorkspacePath(path);
        await fs.writeFile(target, content);
        return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${target}.`;
      },
    }),
    defineTool({
      name: 'edit_file',
      description:
        'Replace exact text in a file. old_string must match the file exactly (whitespace included) and be unique, unless replace_all is true. Read the file first.',
      input: editFileInput,
      needsApproval: approvals.edit_file,
      execute: (args) => editFile(fs, args),
    }),
  ];
}

/**
 * Create file system tools - `read_file`, `write_file`, `edit_file`,
 * `list_dir`, `glob` and `grep` - over any {@link FsProvider}.
 *
 * Paths are workspace-relative; a path that escapes the workspace, a missing
 * file or an ambiguous edit becomes a tool error the model can read and
 * recover from, never an exception that ends the run. Outputs are capped and
 * say when they were truncated.
 *
 * @example
 * ```ts
 * import { createAgent, createFsTools, MemoryWorkspace } from '@loushy/build-ai-agent';
 * import { mockModel } from '@loushy/build-ai-agent/testing';
 * const workspace = new MemoryWorkspace({ files: { 'notes.md': '# Notes\n' } });
 * const agent = createAgent({
 *   prompt: 'You edit files in the workspace.',
 *   provider: mockModel(['Done.']),
 *   tools: createFsTools(workspace, { needsApproval: { write_file: true } }),
 * });
 * ```
 */
export function createFsTools(fs: FsProvider, options: FsToolsOptions = {}): DefinedTool[] {
  const limits = resolveLimits(options);
  const approvals = options.needsApproval ?? {};
  const tools = readOnlyTools(fs, limits, approvals);
  return options.readOnly ? tools : [tools[0], ...mutatingTools(fs, approvals), ...tools.slice(1)];
}
