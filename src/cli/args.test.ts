import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { parseCommand, portValue, usageError, type CommandSpec } from './args';
import { runBuild, parseBuildArgs } from './build';
import { parseChatArgs, runChat } from './chat';
import { parseDevArgs, runDev } from './dev';
import { parseDoctorArgs, runDoctorCommand } from './doctor';
import { parseEvalArgs, runEval } from './eval';
import { parseMcpArgs, runMcp } from './mcp';
import { parseStudioArgs, runStudio } from './studio';

afterEach(() => vi.restoreAllMocks());

const SPEC: CommandSpec = {
  command: 'demo',
  usage: 'Usage: lousho demo [path] [--name n] [--tag t]... [--all]',
  positionals: 1,
  options: { name: { type: 'string' }, tag: { type: 'string', multiple: true }, all: { type: 'boolean' } },
};

describe('parseCommand', () => {
  it('accepts --flag value and --flag=value, repeated flags and positionals', () => {
    expect(parseCommand(SPEC, ['p', '--name', 'a', '--tag=x', '--tag', 'y', '--all']).values).toEqual({ name: 'a', tag: ['x', 'y'], all: true });
    expect(parseCommand(SPEC, ['--name=a', '--name=b']).values.name).toBe('b');
    expect(parseCommand(SPEC, ['--name', 'a', 'p']).positionals).toEqual(['p']);
  });

  it('rejects an unknown flag, a missing value and an extra argument with LOUSHO_CONFIG_INVALID and the usage as the hint', () => {
    for (const [args, message] of [
      [['--bogus'], /unknown option '--bogus'\./],
      [['-z'], /unknown option '-z'\./],
      [['--name'], /--name needs a value\./],
      [['--name', '--all'], /--name needs a value\./],
      [['--all=yes'], /--all does not take a value\./],
      [['a', 'b'], /unexpected argument 'b'\./],
    ] as const) {
      expect(() => parseCommand(SPEC, args)).toThrowError(message);
      try {
        parseCommand(SPEC, args);
      } catch (error) {
        expect(error).toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', hint: SPEC.usage });
        expect((error as Error).message).toMatch(/^lousho demo: /);
      }
    }
  });

  it('takes a value that starts with - only in the = form, and ends the flags at --', () => {
    expect(parseCommand(SPEC, ['--name=-x']).values.name).toBe('-x');
    expect(() => parseCommand(SPEC, ['--name', '-x'])).toThrowError(/--name needs a value/);
    const parsed = parseCommand(SPEC, ['--name', 'a', '--', '--all']);
    expect(parsed.positionals).toEqual(['--all']);
    expect(parsed.values.all).toBeUndefined();
  });

  it('reports -h and --help, skipping the positional check', () => {
    expect(parseCommand(SPEC, ['-h']).help).toBe(true);
    expect(parseCommand(SPEC, ['a', 'b', '--help']).help).toBe(true);
    expect(parseCommand(SPEC, []).help).toBe(false);
  });

  it('validates ports', () => {
    expect(portValue(SPEC, undefined, 3000)).toBe(3000);
    expect(portValue(SPEC, '0', 3000)).toBe(0);
    for (const bad of ['abc', '1.5', '-1', '70000']) expect(() => portValue(SPEC, bad, 1)).toThrowError(/--port must be an integer/);
    expect(usageError(SPEC, 'x')).toMatchObject({ code: 'LOUSHO_CONFIG_INVALID', hint: SPEC.usage });
  });
});

interface Case {
  command: string;
  parse: (args: string[]) => unknown;
  /** Arguments every valid invocation needs (a path). */
  base: string[];
  /** A string flag, the key it lands on and a sample value. */
  flag?: [flag: string, key: string, value: string];
  /** Whether the command takes positionals: how many (Infinity: any). */
  positionals: number;
  run: (args: string[]) => Promise<number>;
}

const CASES: Case[] = [
  { command: 'eval', parse: parseEvalArgs, base: [], flag: ['--junit', 'junit', 'out/j.xml'], positionals: Infinity, run: (a) => runEval(a) },
  { command: 'chat', parse: parseChatArgs, base: ['a.yaml'], flag: ['--session', 'session', 's1'], positionals: 1, run: (a) => runChat(a, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) },
  { command: 'dev', parse: parseDevArgs, base: ['a.yaml'], flag: ['--host', 'host', '0.0.0.0'], positionals: 1, run: runDev },
  { command: 'build', parse: parseBuildArgs, base: [], flag: ['--target', 'target', 'stub'], positionals: 0, run: (a) => runBuild(a, { stdout: () => {}, stderr: () => {} }) },
  { command: 'mcp', parse: parseMcpArgs, base: ['a.yaml'], flag: ['--host', 'host', '0.0.0.0'], positionals: 1, run: runMcp },
  { command: 'studio', parse: parseStudioArgs, base: [], flag: ['--host', 'apiHost', '0.0.0.0'], positionals: 0, run: runStudio },
  { command: 'doctor', parse: parseDoctorArgs, base: [], positionals: 1, run: (a) => runDoctorCommand(a, undefined, () => {}) },
];

describe.each(CASES)('lousho $command flag parsing', ({ command, parse, base, run }) => {
  const usage = new RegExp(`Usage: lousho ${command}`);

  it('rejects an unknown flag with LOUSHO_CONFIG_INVALID and the usage line', () => {
    for (const arg of ['--bogus', '--bogus=1', '-z']) {
      expect(() => parse([...base, arg])).toThrowError(/unknown option/);
      expect(() => parse([...base, arg])).toThrowError(usage);
      expect(() => parse([...base, arg])).toThrowError(/LOUSHO_CONFIG_INVALID/);
    }
  });

  it('prints the usage for -h and --help and exits 0 without running', async () => {
    for (const arg of ['-h', '--help']) {
      expect(parse([arg])).toMatchObject({ help: true });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await run([arg])).toBe(0);
      log.mockRestore();
    }
  });
});

describe.each(CASES.filter((c) => c.positionals < Infinity))('lousho $command extra arguments', ({ parse, base }) => {
  it('rejects an extra positional argument', () => {
    expect(() => parse([...base, 'extra-one', 'extra-two'])).toThrowError(/unexpected argument|unknown option/);
  });
});

describe.each(CASES.filter((c) => c.flag))('lousho $command flag values', ({ parse, base, flag }) => {
  it('takes a value as --flag value or --flag=value, and a repeated flag keeps the last', () => {
    const [name, key, value] = flag!;
    expect(parse([...base, name, value])).toMatchObject({ [key]: value });
    expect(parse([...base, `${name}=${value}`])).toMatchObject({ [key]: value });
    expect(parse([...base, `${name}=first`, `${name}=${value}`])).toMatchObject({ [key]: value });
  });

  it('does not let a flag without its value swallow the next flag', () => {
    const [name] = flag!;
    expect(() => parse([...base, name])).toThrowError(new RegExp(`${name} needs a value`));
    expect(() => parse([...base, name, '--bogus'])).toThrowError(new RegExp(`${name} needs a value`));
    expect(() => parse([...base, name, '-h'])).toThrowError(new RegExp(`${name} needs a value`));
  });

  it('takes a value starting with - in the = form only', () => {
    const [name, key] = flag!;
    expect(parse([...base, `${name}=-x`])).toMatchObject({ [key]: '-x' });
    expect(() => parse([...base, name, '-x'])).toThrowError(new RegExp(`${name} needs a value`));
  });
});

describe.each(CASES.filter((c) => c.positionals >= 1))('lousho $command --', ({ parse }) => {
  it('ends the flags at --', () => {
    const args = parse(['--', '--looks-like-a-flag']) as { path?: string; configPath?: string; specPath?: string; globs?: string[] };
    expect(args.path ?? args.configPath ?? args.specPath ?? args.globs?.[0]).toBe('--looks-like-a-flag');
  });
});

describe('lousho mcp, dev and studio ports', () => {
  it('reject a port that is not an integer from 0 to 65535 and accept --port=N', () => {
    for (const parse of [parseMcpArgs, parseDevArgs, parseStudioArgs]) {
      expect(() => parse([...(parse === parseStudioArgs ? [] : ['a.yaml']), '--port', 'abc'])).toThrowError(/--port must be an integer between 0 and 65535/);
      expect(parse([...(parse === parseStudioArgs ? [] : ['a.yaml']), '--port=4000'])).toMatchObject({ [parse === parseStudioArgs ? 'apiPort' : 'port']: 4000 });
    }
  });

  it('studio rejects --prod with --dev', () => {
    expect(parseStudioArgs(['--prod']).mode).toBe('prod');
    expect(parseStudioArgs(['--dev']).mode).toBe('dev');
    expect(() => parseStudioArgs(['--prod', '--dev'])).toThrowError(/cannot be combined/);
  });
});

describe('lousho chat and eval specifics', () => {
  it('chat help does not need a path, and a missing path still fails', () => {
    expect(parseChatArgs(['--help']).help).toBe(true);
    expect(() => parseChatArgs([])).toThrowError(/a path is required/);
  });

  it('eval splits repeated and comma-separated --tag values and keeps globs around flags', () => {
    expect(parseEvalArgs(['a.eval.ts', '--tag=x,y', '--tag', 'z', 'b.eval.ts'])).toMatchObject({ globs: ['a.eval.ts', 'b.eval.ts'], tags: ['x', 'y', 'z'] });
  });
});
