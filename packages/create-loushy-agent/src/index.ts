import { parseArgs } from 'node:util';

const USAGE = `create-loushy-agent - scaffold a new @loushy/build-ai-agent project

Usage:
  create-loushy-agent [options]

Options:
  --name <name>          Project name (skips the interactive prompt)
  --provider <provider>  LLM provider: openai | anthropic | ollama
  --tools <list>         Comma-separated tool list (e.g. "http,github")
  --yes, -y              Accept flag values / defaults without prompting
  --help, -h             Show this help message
`;

export interface ParsedCliArgs {
  help: boolean;
  yes: boolean;
  name?: string;
  provider?: string;
  tools?: string;
}

/**
 * Parses argv using Node's built-in util.parseArgs (no new dependency).
 * Throws a descriptive error for an unrecognized flag rather than letting
 * parseArgs's own generic error surface.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        name: { type: 'string' },
        provider: { type: 'string' },
        tools: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // node:util's parseArgs error message for an unknown flag looks like
    // "Unknown option '--xyz'" - normalize to the exact phrasing this
    // ticket asks for.
    const match = message.match(/Unknown option '(--?[^']+)'/);
    if (match) {
      throw new CliArgError(`Unknown flag: ${match[1]}`);
    }
    throw new CliArgError(message);
  }

  return {
    help: !!values.help,
    yes: !!values.yes,
    name: values.name as string | undefined,
    provider: values.provider as string | undefined,
    tools: values.tools as string | undefined,
  };
}

export class CliArgError extends Error {}

/**
 * CLI entry point. Returns a process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliArgError) {
      process.stderr.write(error.message + '\n');
      return 1;
    }
    throw error;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  return runScaffold(args);
}

/**
 * Placeholder scaffold step, overridden by LOU-H3/LOU-H4 wiring (prompts +
 * template generation) added in later commits of this same file.
 */
async function runScaffold(_args: ParsedCliArgs): Promise<number> {
  process.stdout.write('create-loushy-agent: nothing to do yet.\n');
  return 0;
}
