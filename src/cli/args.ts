/**
 * The one flag parser every `lousho` command uses (LOU-U21): `node:util`'s
 * `parseArgs` in strict mode, with errors in the CLI's coded style.
 *
 * - `--flag value` and `--flag=value` both work; a repeated flag keeps its last value
 *   (every value with `multiple: true`); `--` ends the flags.
 * - An unknown flag, a flag without its value (`--port --host`, `--port` last) and an
 *   extra positional are `LOUSHO_CONFIG_INVALID` with the command's usage line as the hint.
 * - A value that starts with `-` must use the `=` form (`--model=-x`) or follow `--`.
 * - `-h` / `--help` is accepted everywhere: `help` is true and nothing else is validated.
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { SDKError } from '../execution/errors';

type Options = NonNullable<ParseArgsConfig['options']>;
type Value = string | boolean | (string | boolean)[] | undefined;

export interface CommandSpec {
  /** The command name, for messages (`chat` gives `lousho chat: ...`). */
  command: string;
  /** The command's usage line; the hint of every parse error and what `--help` prints. */
  usage: string;
  /** The flags; `-h` / `--help` is added. */
  options: Options;
  /** How many positional arguments are accepted (default 0). */
  positionals?: number;
}

export interface ParsedCommand {
  values: Record<string, Value>;
  positionals: string[];
  help: boolean;
}

/** The coded usage error every command shares. */
export function usageError(spec: Pick<CommandSpec, 'command' | 'usage'>, message: string): SDKError {
  return new SDKError(`lousho ${spec.command}: ${message}`, 'LOUSHO_CONFIG_INVALID', { hint: spec.usage });
}

/** Node's error text, in the CLI's words (`unknown option '--x'.`, `--x needs a value.`). */
function describe(error: unknown): string {
  const { code, message } = error as { code?: string; message: string };
  const flag = /'(-[^'\s]*)/.exec(message)?.[1] ?? '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `unknown option '${flag}'.`;
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    return message.includes('does not take') ? `${flag} does not take a value.` : `${flag} needs a value.`;
  }
  return `${message}.`;
}

/** Parses the arguments after the command name against its flags. */
export function parseCommand(spec: CommandSpec, args: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { ...spec.options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw usageError(spec, describe(error));
  }
  const values = parsed.values as Record<string, Value>;
  const help = values.help === true;
  const max = spec.positionals ?? 0;
  if (!help && parsed.positionals.length > max) {
    throw usageError(spec, `unexpected argument '${parsed.positionals[max]}'.`);
  }
  return { values, positionals: parsed.positionals, help };
}

/**
 * Takes a `--<name>[=value]` flag out of `args` (before any `--`): a flag whose value is optional.
 * `parseArgs` cannot express that, and a space-separated value would swallow the positional path
 * (`lousho dev --traces agent.yaml`), so the value must use the `=` form. `value` is `true` for the bare
 * flag, the text after `=`, or `undefined` when the flag is absent; an empty `--name=` is a usage error.
 */
export function takeOptionalValueFlag(
  spec: Pick<CommandSpec, 'command' | 'usage'>,
  args: readonly string[],
  name: string
): { rest: string[]; value: string | true | undefined } {
  const rest: string[] = [];
  let value: string | true | undefined;
  let flags = true;
  for (const arg of args) {
    if (arg === '--') flags = false;
    if (flags && arg === `--${name}`) value = true;
    else if (flags && arg.startsWith(`--${name}=`)) {
      const given = arg.slice(name.length + 3);
      if (!given) throw usageError(spec, `--${name}= needs a directory (or use --${name} alone).`);
      value = given;
    } else rest.push(arg);
  }
  return { rest, value };
}

/** A string flag's value (the last one when repeated), or undefined. */
export function stringValue(value: Value): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A `--port` value: an integer from 0 to 65535, or `fallback` when the flag is absent. */
export function portValue(spec: CommandSpec, value: Value, fallback: number): number {
  const port = Number(stringValue(value) ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw usageError(spec, '--port must be an integer between 0 and 65535.');
  return port;
}
