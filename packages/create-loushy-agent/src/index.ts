import { parseArgs } from 'node:util';
import path from 'node:path';
import { collectAnswers, validateAnswers, AnswerConfig } from './prompts';
import { generateProject } from './template';

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
  dir?: string;
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
        dir: { type: 'string' },
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
    dir: values.dir as string | undefined,
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
 * Resolves the AnswerConfig either from --yes/flag shortcuts (non-interactive,
 * testable via a piped/scripted process) or by running the interactive
 * prompts.ts flow. A flag-only invocation ("--yes" or both "--name" and
 * "--provider" given) never touches the interactive prompts, which is what
 * makes this reliably testable end-to-end without a real TTY.
 */
async function resolveAnswers(args: ParsedCliArgs): Promise<AnswerConfig> {
  const useShortcut = args.yes || (!!args.name && !!args.provider);

  if (!useShortcut) {
    return collectAnswers();
  }

  return validateAnswers({
    name: args.name || 'my-loushy-agent',
    provider: args.provider || 'openai',
    tools: args.tools ? args.tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
  });
}

/**
 * Scaffold step: resolve answers, then generate the project on disk.
 * --dir overrides the target directory (defaults to ./<name>); used by
 * tests to target a temp directory instead of the CLI's own cwd.
 */
async function runScaffold(args: ParsedCliArgs): Promise<number> {
  const answers = await resolveAnswers(args);
  const targetDir = args.dir || path.join(process.cwd(), answers.name);

  process.stdout.write(`Scaffolding ${answers.name} (${answers.provider}) into ${targetDir}...\n`);
  await generateProject(targetDir, answers);
  process.stdout.write('Done.\n');
  return 0;
}
