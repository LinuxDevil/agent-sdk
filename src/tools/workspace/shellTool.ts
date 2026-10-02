/**
 * createShellTool: a `shell` tool over any ShellProvider (LOU-X6).
 */
import { z } from 'zod';
import { defineTool, type DefinedTool } from '../defineTool';
import type { ShellExecResult, ShellProvider } from './types';
import { WorkspaceError } from './paths';

/**
 * A command pattern for {@link ShellToolOptions.allow} / {@link ShellToolOptions.deny}.
 *
 * - A string matches a command that is exactly it or starts with it followed
 *   by whitespace: `'git status'` matches `git status -s` but not `git statusx`.
 * - A RegExp is tested against the whole command line; anchor it (`/^npm (test|run lint)$/`).
 */
export type CommandPattern = string | RegExp;

/** Options for {@link createShellTool}. */
export interface ShellToolOptions {
  /** Tool name the model calls. Defaults to `'shell'`. */
  name?: string;
  /**
   * Require human approval before a command runs. Defaults to `true` (safe by
   * default). Pass a predicate to decide per command, e.g. to auto-approve
   * read-only commands.
   * @example needsApproval: (command) => !/^(ls|cat|git (status|diff|log))\b/.test(command)
   */
  needsApproval?: boolean | ((command: string) => boolean | Promise<boolean>);
  /**
   * Only commands matching one of these patterns may run; anything else is
   * refused as a tool error before approval is asked. A command matched only
   * by a string pattern must not contain shell operators
   * (`;` `&` `|` `` ` `` `$(` `<` `>` or a newline), so `git status; rm -rf ~`
   * does not pass as `git status`.
   */
  allow?: readonly CommandPattern[];
  /**
   * Commands matching any of these patterns are refused as a tool error before
   * approval is asked. String patterns are checked against every
   * `;`/`&`/`|`-separated part of the command. A deny list is a convenience,
   * not a security boundary - shells offer endless ways to spell a command.
   */
  deny?: readonly CommandPattern[];
  /** Timeout when the model does not pass `timeout_ms`. Defaults to 120,000 (2 minutes). */
  defaultTimeoutMs?: number;
  /** Upper bound for `timeout_ms`; larger requests are clamped. Defaults to 600,000 (10 minutes). */
  maxTimeoutMs?: number;
  /** Most characters returned per stream; the middle is cut beyond it. Defaults to 30,000. */
  maxOutputChars?: number;
  /** Working directory for every command, relative to the workspace root. */
  cwd?: string;
  /** Extra environment variables for every command. */
  env?: Record<string, string>;
}

const SHELL_OPERATORS = /[;&|`<>\n\r]|\$\(/;
const COMMAND_SEPARATORS = /[;&|`()\n\r]|\$\(/;

function matchesPrefix(command: string, pattern: string): boolean {
  const c = command.trim();
  const p = pattern.trim();
  return c === p || c.startsWith(`${p} `) || c.startsWith(`${p}\t`);
}

function testRegex(pattern: RegExp, command: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(command);
}

function deniedBy(command: string, deny: readonly CommandPattern[]): CommandPattern | undefined {
  const parts = command.split(COMMAND_SEPARATORS);
  return deny.find((p) =>
    typeof p === 'string' ? parts.some((part) => matchesPrefix(part, p)) : testRegex(p, command)
  );
}

function isAllowed(command: string, allow: readonly CommandPattern[]): boolean {
  const hasOperators = SHELL_OPERATORS.test(command);
  return allow.some((p) => (typeof p === 'string' ? !hasOperators && matchesPrefix(command, p) : testRegex(p, command)));
}

/** Why `command` is refused by the allow/deny lists, or undefined when it may run. */
function policyViolation(command: string, options: ShellToolOptions): string | undefined {
  const denied = options.deny && deniedBy(command, options.deny);
  if (denied !== undefined) {
    return `Command refused: it matches the deny pattern ${String(denied)}. Use a different command.`;
  }
  if (options.allow && !isAllowed(command, options.allow)) {
    const allowed = options.allow.map(String).join(', ');
    const operators = SHELL_OPERATORS.test(command)
      ? ' Chaining, pipes, substitution and redirection (; & | ` $( < >) are not allowed with these patterns.'
      : '';
    return `Command refused: it is not on the allow list (${allowed}).${operators}`;
  }
  return undefined;
}

/** Keeps the head and tail of `text`, marking the cut. */
function capOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n... [${omitted} characters omitted] ...\n${text.slice(text.length - half)}`;
}

/** What the model sees for a finished command. */
export interface ShellToolResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
  /** Present when the command was killed, explaining why. */
  note?: string;
}

function toToolResult(result: ShellExecResult, timeoutMs: number, maxChars: number): ShellToolResult {
  const out: ShellToolResult = {
    exitCode: result.exitCode,
    stdout: capOutput(result.stdout, maxChars),
    stderr: capOutput(result.stderr, maxChars),
  };
  if (result.timedOut) {
    out.timedOut = true;
    out.note = `The command timed out after ${timeoutMs}ms and was killed. Pass a larger timeout_ms if it needs longer.`;
  }
  if (result.aborted) {
    out.aborted = true;
    out.note = 'The run was cancelled, so the command was killed.';
  }
  return out;
}

/**
 * Create a `shell` tool that runs commands through a {@link ShellProvider}
 * (e.g. `NodeWorkspace`, `SandboxShell`, or your own remote sandbox).
 *
 * Safe by default: every command needs human approval unless you pass
 * `needsApproval: false` or a predicate. `allow`/`deny` patterns are checked
 * first, so a refused command is never offered for approval. Output is capped
 * (head and tail kept), the timeout kills the command, and cancelling the run
 * (its `AbortSignal`) kills the command's whole process tree.
 *
 * @example
 * ```ts
 * import { createShellTool, NodeWorkspace } from '@lousho/build-ai-agent';
 * const workspace = new NodeWorkspace({ root: '.' });
 * const shell = createShellTool(workspace, {
 *   needsApproval: (command) => !command.startsWith('git status'),
 *   deny: ['rm -rf', /\bsudo\b/],
 * });
 * ```
 */
export function createShellTool(shell: ShellProvider, options: ShellToolOptions = {}): DefinedTool {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;
  const maxOutputChars = options.maxOutputChars ?? 30_000;
  const approval = options.needsApproval ?? true;
  return defineTool({
    name: options.name ?? 'shell',
    description:
      'Run a shell command in the workspace directory and return its exit code, stdout and stderr. ' +
      `Commands are killed after timeout_ms (default ${defaultTimeoutMs}ms, max ${maxTimeoutMs}ms). Long output is cut in the middle.`,
    input: z.object({
      command: z.string().min(1).describe('The command line to run, e.g. "npm test".'),
      timeout_ms: z.number().int().min(1).optional().describe(`Timeout in milliseconds (max ${maxTimeoutMs}).`),
    }),
    needsApproval: async ({ command }) => {
      if (policyViolation(command, options)) return false; // refused in execute; never ask
      return typeof approval === 'function' ? approval(command) : approval;
    },
    async execute({ command, timeout_ms }, ctx) {
      const violation = policyViolation(command, options);
      if (violation) throw new WorkspaceError(violation);
      const timeoutMs = Math.min(timeout_ms ?? defaultTimeoutMs, maxTimeoutMs);
      const result = await shell.exec(command, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs,
        signal: ctx?.abortSignal,
      });
      return toToolResult(result, timeoutMs, maxOutputChars);
    },
  });
}
