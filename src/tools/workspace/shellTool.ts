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
 *   The command must not contain shell operators or a path that leaves the
 *   working directory — a `..` segment, `~` or an absolute path, anywhere in
 *   the command including a `--flag=value` — so `node --test --out=../x` does
 *   not pass as `node --test`. Use a {@link CommandRule} or an anchored
 *   RegExp for arguments like that.
 * - A {@link CommandRule} pins the arguments: `{ command: 'npm test' }` matches
 *   only `npm test`; add `args` to validate what follows.
 * - A RegExp is tested against the whole command line; anchor it (`/^npm (test|run lint)$/`).
 */
export type CommandPattern = string | RegExp | CommandRule;

/**
 * An allow/deny pattern that controls the arguments of a command.
 *
 * Without `args` it is an exact match: `{ command: 'npm test' }` matches
 * `npm test` and nothing else. With `args`, the command must start with
 * `command` and `args` decides about the rest (trimmed; `''` when there is
 * none). Like a string pattern, it never matches a command containing shell
 * operators.
 *
 * @example
 * ```ts
 * const nodeTest = { command: 'node --test', args: (rest: string) => /^([\w./-]+\.test\.js\s*)*$/.test(rest) };
 * ```
 */
export interface CommandRule {
  /** The program and any fixed leading arguments, e.g. `'node --test'`. */
  command: string;
  /** Validates the arguments after `command`. Omit it to allow no arguments at all. */
  args?: (args: string) => boolean;
}

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
   * by a string pattern or {@link CommandRule} must not contain shell operators
   * (`;` `&` `|` `` ` `` `$(` `<` `>` or a newline; also `%` and `^` under
   * cmd.exe), so `git status; rm -rf ~` does not pass as `git status`. A
   * command matched only by a string pattern must also not contain a path
   * that leaves the working directory (a `..` segment, `~` or an absolute
   * path), so `node --test --out=../x` does not pass as `node --test`.
   *
   * Use a {@link CommandRule} to pin arguments, or an anchored RegExp to
   * allow arguments like those.
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
/** cmd.exe also expands `%VAR%` and treats `^` as an escape character. */
const CMD_OPERATORS = /[;&|`<>\n\r%^]|\$\(/;
const COMMAND_SEPARATORS = /[;&|`()\n\r]|\$\(/;
/**
 * A whitespace-separated token that would read or write outside the working
 * directory: a `..` path segment (`../x`, `a/../b`, `--out=../x`), a `~` home
 * path, or an absolute path (`/x`, `C:\x`, `\\share`), including a `=value`.
 * `main..feature` and `https://...` are not matches.
 */
const ESCAPING_TOKEN = /(?:^|[/\\=])\.\.(?:[/\\]|$)|(?:^|=)(?:~(?:[/\\]|$)|[/\\]|[a-zA-Z]:[/\\])/;

/** The shell a provider runs, when it says so (`NodeWorkspace`, `SandboxShell`). */
function providerShell(shell: ShellProvider): string | undefined {
  return typeof shell.shell === 'string' ? shell.shell : undefined;
}

/** True for cmd.exe. A provider that does not name its shell is assumed to use cmd.exe on Windows. */
function isCmdShell(shell: string | undefined): boolean {
  if (shell === undefined) return process.platform === 'win32';
  return /(^|[\\/])cmd(\.exe)?$/i.test(shell.trim());
}

/** The arguments after `pattern` when `command` is it or starts with it plus whitespace. */
function argsAfter(command: string, pattern: string): string | undefined {
  const c = command.trim();
  const p = pattern.trim();
  if (c === p) return '';
  return c.startsWith(`${p} `) || c.startsWith(`${p}\t`) ? c.slice(p.length).trim() : undefined;
}

function matchesPrefix(command: string, pattern: string): boolean {
  return argsAfter(command, pattern) !== undefined;
}

function matchesRule(command: string, rule: CommandRule): boolean {
  const args = argsAfter(command, rule.command);
  if (args === undefined) return false;
  return rule.args ? rule.args(args) : args === '';
}

function testRegex(pattern: RegExp, command: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(command);
}

function patternText(pattern: CommandPattern): string {
  if (typeof pattern === 'string' || pattern instanceof RegExp) return String(pattern);
  return pattern.args ? `${pattern.command} <checked arguments>` : `${pattern.command} (exactly)`;
}

function deniedBy(command: string, deny: readonly CommandPattern[]): CommandPattern | undefined {
  const parts = command.split(COMMAND_SEPARATORS);
  return deny.find((p) => {
    if (p instanceof RegExp) return testRegex(p, command);
    return parts.some((part) => (typeof p === 'string' ? matchesPrefix(part, p) : matchesRule(part, p)));
  });
}

function isAllowed(command: string, allow: readonly CommandPattern[], operators: RegExp): boolean {
  const hasOperators = operators.test(command);
  // A string pattern allows the command and ordinary flags only: arguments
  // that leave the workspace need a CommandRule or an anchored RegExp.
  const escaping = command.split(/\s+/).some((token) => ESCAPING_TOKEN.test(token));
  return allow.some((p) => {
    if (p instanceof RegExp) return testRegex(p, command);
    if (hasOperators) return false;
    return typeof p === 'string' ? !escaping && matchesPrefix(command, p) : matchesRule(command, p);
  });
}

/** Why `command` is refused by the allow/deny lists, or undefined when it may run. */
function policyViolation(command: string, options: ShellToolOptions, cmd: boolean): string | undefined {
  const denied = options.deny && deniedBy(command, options.deny);
  if (denied !== undefined) {
    return `Command refused: it matches the deny pattern ${patternText(denied)}. Use a different command.`;
  }
  const operators = cmd ? CMD_OPERATORS : SHELL_OPERATORS;
  if (options.allow && !isAllowed(command, options.allow, operators)) {
    const allowed = options.allow.map(patternText).join(', ');
    const hasStrings = options.allow.some((p) => typeof p === 'string');
    const restricted = [
      operators.test(command) && `Chaining, pipes, substitution and redirection (; & | \` $( < >${cmd ? ' % ^' : ''})`,
      hasStrings &&
        command.split(/\s+/).some((token) => ESCAPING_TOKEN.test(token)) &&
        "paths outside the workspace ('..' segments, '~' and absolute paths)",
    ]
      .filter(Boolean)
      .join(' and ');
    const hint = restricted ? ` ${restricted} are not allowed with ${hasStrings ? 'string patterns' : 'these patterns'}.` : '';
    return `Command refused: it is not on the allow list (${allowed}).${hint}`;
  }
  return undefined;
}

/** One sentence telling the model which shell syntax to use. */
function shellHint(shell: string | undefined): string {
  if (shell === undefined) return '';
  if (isCmdShell(shell)) {
    return ' Commands run in Windows cmd.exe: quote with double quotes (single quotes are passed through literally), variables are %NAME%, and $HOME and ~ do not expand.';
  }
  return ` Commands run in a POSIX shell (${shell}): use sh syntax and quoting.`;
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
  const shellName = providerShell(shell);
  const cmd = isCmdShell(shellName);
  return defineTool({
    name: options.name ?? 'shell',
    description:
      'Run a shell command in the workspace directory and return its exit code, stdout and stderr. ' +
      `Commands are killed after timeout_ms (default ${defaultTimeoutMs}ms, max ${maxTimeoutMs}ms). Long output is cut in the middle.` +
      shellHint(shellName),
    input: z.object({
      command: z.string().min(1).describe('The command line to run, e.g. "npm test".'),
      timeout_ms: z.number().int().min(1).optional().describe(`Timeout in milliseconds (max ${maxTimeoutMs}).`),
    }),
    needsApproval: async ({ command }) => {
      if (policyViolation(command, options, cmd)) return false; // refused in execute; never ask
      return typeof approval === 'function' ? approval(command) : approval;
    },
    async execute({ command, timeout_ms }, ctx) {
      const violation = policyViolation(command, options, cmd);
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
