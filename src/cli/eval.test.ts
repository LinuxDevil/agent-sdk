import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildVitestConfig,
  createVitestSpawner,
  parseEvalArgs,
  resolveVitestBin,
  runEval,
  toRootRelativeGlob,
  type VitestSpawner,
} from './eval';
import type { EvalResult } from '../evals/evalResult';
import { RESULTS_ENV, TAGS_ENV } from '../evals/recorder';

const FIXTURES = path.resolve(__dirname, '__fixtures__', 'eval');

function tempFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-eval-test-')), name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseEvalArgs', () => {
  it('defaults to no globs and normal (non-strict, non-judge) mode', () => {
    expect(parseEvalArgs([])).toEqual({ globs: [], tags: [], strict: false, judge: false });
  });

  it('reads globs, repeatable/comma --tag, and both flag styles', () => {
    expect(
      parseEvalArgs(['a/*.eval.ts', '--tag', 'smoke,fast', '--tag=nightly', '--junit', 'out/j.xml', '--json=out/r.json', '--strict', '--judge', 'b.eval.ts', '--config', 'v.config.ts'])
    ).toEqual({
      globs: ['a/*.eval.ts', 'b.eval.ts'],
      tags: ['smoke', 'fast', 'nightly'],
      junit: 'out/j.xml',
      json: 'out/r.json',
      strict: true,
      judge: true,
      config: 'v.config.ts',
    });
  });

  it('reads the cassette flags; --drift-usage implies --drift and only one mode is allowed', () => {
    expect(parseEvalArgs(['--record'])).toMatchObject({ record: true });
    expect(parseEvalArgs(['--drift-usage'])).toMatchObject({ drift: true, driftUsage: true });
    expect(() => parseEvalArgs(['--record', '--replay'])).toThrow(/only one of --record, --replay and --drift/);
    expect(() => parseEvalArgs(['--replay', '--drift'])).toThrow(/only one of/);
  });

  it('explains how to fix an unknown option or a missing value', () => {
    expect(() => parseEvalArgs(['--bogus'])).toThrow(/unknown option '--bogus'[\s\S]*Usage: loushy eval/);
    expect(() => parseEvalArgs(['--junit'])).toThrow(/--junit needs a value/);
    expect(() => parseEvalArgs(['--tag', '--strict'])).toThrow(/--tag needs a value/);
  });
});

describe('buildVitestConfig', () => {
  it('collects *.eval files but never judge evals by default', () => {
    const config = buildVitestConfig({ globs: [], judge: false });
    expect(config).toContain('"**/*.eval.{ts,mts,js,mjs}"');
    expect(config).toContain('"**/*.judge.eval.*"');
    expect(config).not.toContain('LOUSHY_ALLOW_LLM_JUDGE');
  });

  it('collects only judge evals and allows the judge with --judge', () => {
    const config = buildVitestConfig({ globs: [], judge: true });
    expect(config).toContain('"**/*.judge.eval.{ts,mts,js,mjs}"');
    expect(config).toContain('"LOUSHY_ALLOW_LLM_JUDGE": "1"');
  });

  it('uses the given globs as the include list', () => {
    expect(buildVitestConfig({ globs: ['evals/**/*.ts'], judge: false })).toContain('"evals/**/*.ts"');
  });
});

describe('toRootRelativeGlob', () => {
  it('keeps relative globs and makes absolute paths root-relative with forward slashes', () => {
    const cwd = path.resolve('proj');
    expect(toRootRelativeGlob('evals/**/*.eval.ts', cwd)).toBe('evals/**/*.eval.ts');
    expect(toRootRelativeGlob(path.join(cwd, 'evals', 'a.eval.ts'), cwd)).toBe('evals/a.eval.ts');
  });
});

describe('resolveVitestBin', () => {
  it('finds vitest from this project and returns undefined where it is not installed', () => {
    expect(resolveVitestBin(process.cwd())).toMatch(/vitest\.mjs$/);
    expect(resolveVitestBin(os.tmpdir())).toBeUndefined();
  });
});

function result(overrides: Partial<EvalResult>): EvalResult {
  return { name: 'e', tags: [], passed: true, assertions: [], durationMs: 5, steps: 1, toolCalls: [], ...overrides };
}

/** A fake vitest that records its invocation and appends canned results to the results file. */
function fakeVitest(results: EvalResult[], code = 0) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; config: string }[] = [];
  const spawnVitest: VitestSpawner = async (_bin, args, env) => {
    calls.push({ args, env, config: fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8') });
    fs.appendFileSync(env[RESULTS_ENV] as string, results.map((r) => `${JSON.stringify(r)}\n`).join(''));
    return code;
  };
  return { spawnVitest, calls };
}

const softResult = result({
  name: 'soft',
  assertions: [{ name: 'tone', kind: 'soft', passed: false, score: 0.2, threshold: 0.7, message: 'too curt' }],
});
const gateResult = result({
  name: 'gate',
  passed: false,
  assertions: [{ name: 'completed()', kind: 'gate', passed: false, score: 0, threshold: 1, message: 'nope' }],
});

describe('runEval with a fake vitest', () => {
  it('exits 2 and prints the install command when vitest is not installed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runEval([], { resolveVitest: () => undefined })).toBe(2);
    expect(error.mock.calls[0][0]).toContain('npm install --save-dev vitest');
  });

  it('exits 2 for bad arguments', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runEval(['--nope'], { resolveVitest: () => 'vitest.mjs' })).toBe(2);
    expect(error.mock.calls[0][0]).toContain("unknown option '--nope'");
  });

  it('passes the tag filter, results file and generated config to vitest and exits 0 on success', async () => {
    const fake = fakeVitest([result({ name: 'ok' })]);
    const log = vi.fn();
    const code = await runEval(['--tag', 'smoke', 'x.eval.ts'], { resolveVitest: () => 'vitest.mjs', spawnVitest: fake.spawnVitest, log, cwd: '/proj' });
    expect(code).toBe(0);
    expect(fake.calls[0].args.slice(0, 1)).toEqual(['run']);
    expect(fake.calls[0].args).toContain('/proj');
    expect(fake.calls[0].env[TAGS_ENV]).toBe('smoke');
    expect(fake.calls[0].config).toContain('"x.eval.ts"');
    expect(log.mock.calls[0][0]).toContain('1 eval(s): 1 passed, 0 failed');
  });

  it('exits 1 on a gate failure and 0 on a soft failure, unless --strict', async () => {
    const run = (extra: string[], results: EvalResult[]) =>
      runEval(extra, { resolveVitest: () => 'v', spawnVitest: fakeVitest(results).spawnVitest, log: () => {} });
    expect(await run([], [gateResult])).toBe(1);
    expect(await run([], [softResult])).toBe(0);
    expect(await run(['--strict'], [softResult])).toBe(1);
  });

  it('exits 1 when vitest itself fails with no recorded failure, so a load error never looks green', async () => {
    const code = await runEval([], { resolveVitest: () => 'v', spawnVitest: fakeVitest([], 1).spawnVitest, log: () => {} });
    expect(code).toBe(1);
  });

  it('says so when no results were recorded', async () => {
    const log = vi.fn();
    await runEval([], { resolveVitest: () => 'v', spawnVitest: fakeVitest([]).spawnVitest, log });
    expect(log.mock.calls[0][0]).toContain('no eval results were recorded');
  });

  it('passes --judge through as the judge env var and uses the user config with --config', async () => {
    const config = tempFile('v.config.mjs');
    fs.writeFileSync(config, 'export default {};');
    const fake = fakeVitest([result({})]);
    await runEval(['--judge', '--config', config, 'only.judge.eval.ts'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fake.calls[0].env.LOUSHY_ALLOW_LLM_JUDGE).toBe('1');
    expect(fake.calls[0].args).toEqual(['run', '--config', config, '--root', process.cwd(), 'only.judge.eval.ts']);
  });

  it('writes the JUnit and JSON reports, creating missing directories', async () => {
    const dir = path.dirname(tempFile('x'));
    const junit = path.join(dir, 'nested', 'junit.xml');
    const json = path.join(dir, 'nested', 'results.json');
    const fake = fakeVitest([gateResult]);
    await runEval(['--junit', junit, '--json', json], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log: () => {} });
    expect(fs.readFileSync(junit, 'utf8')).toContain('<failure message="nope"');
    expect((JSON.parse(fs.readFileSync(json, 'utf8')) as { summary: { failed: number } }).summary.failed).toBe(1);
  });
});

describe('loushy eval --url (LOU-D47)', () => {
  it('parses --url and --token', () => {
    expect(parseEvalArgs(['--url', 'https://a.test', '--token=abc'])).toMatchObject({ url: 'https://a.test', token: 'abc' });
  });

  it('rejects --url with --record, --replay and --drift with a coded error', async () => {
    for (const flag of ['--record', '--replay', '--drift']) {
      expect(() => parseEvalArgs(['--url', 'https://a.test', flag])).toThrow(/cannot be combined/);
      expect(() => parseEvalArgs(['--url', 'https://a.test', flag])).toThrowError(
        expect.objectContaining({ code: 'LOUSHY_CONFIG_CONFLICTING_OPTIONS' })
      );
    }
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runEval(['--url', 'https://a.test', '--replay'], { resolveVitest: () => 'v', log: () => {} })).toBe(2);
  });

  it('hands the URL and token to the vitest worker, turns cassettes off, and never prints the token', async () => {
    vi.stubEnv('CI', 'true');
    const fake = fakeVitest([result({})]);
    const log = vi.fn();
    await runEval(['--url', 'https://a.test', '--token', 'tok-123'], { resolveVitest: () => 'v', spawnVitest: fake.spawnVitest, log });
    vi.unstubAllEnvs();
    expect(fake.calls[0].env).toMatchObject({ LOUSHY_EVAL_URL: 'https://a.test', LOUSHY_EVAL_TOKEN: 'tok-123', LOUSHY_EVAL_CASSETTES: '' });
    expect(log.mock.calls.join('\n')).not.toContain('tok-123');
  });
});

describe('loushy eval end to end (real vitest, mockModel fixtures)', () => {
  // The real vitest, with its own console output discarded to keep this suite's log readable.
  const quietVitest = createVitestSpawner('ignore');

  const cli = (args: string[]) => {
    const log = vi.fn();
    return runEval(args, { log, spawnVitest: quietVitest }).then((code) => ({ code, output: log.mock.calls.map((c) => String(c[0])).join('\n') }));
  };

  it('runs a passing eval: exit 0, JUnit and JSON written, soft failure reported but not failing', async () => {
    const junit = tempFile('junit.xml');
    const json = tempFile('results.json');
    const { code, output } = await cli([path.join(FIXTURES, 'refund.eval.ts'), '--junit', junit, '--json', json]);

    expect(code).toBe(0);
    expect(output).toContain('3 eval(s): 3 passed, 0 failed, 2 with soft failures');
    expect(output).toContain('PASS (soft fail)');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('<testsuite name="refund flow" tests="2" failures="0" errors="0"');
    expect(xml).toContain('<testcase classname="refund flow" name="polite"');
    expect(xml).toContain('<testsuite name="nightly only" tests="1"');
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8')) as { results: EvalResult[] };
    expect(parsed.results.find((r) => r.case === 'polite')).toMatchObject({
      passed: true,
      steps: 2,
      toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }],
    });
  }, 60_000);

  it('--tag runs only matching evals, and --strict turns the soft failure into exit 1', async () => {
    const { code, output } = await cli([path.join(FIXTURES, 'refund.eval.ts'), '--tag', 'smoke', '--strict']);
    expect(code).toBe(1);
    expect(output).toContain('2 eval(s): 0 passed, 2 failed');
    expect(output).not.toContain('nightly only');
  }, 60_000);

  it('a failing gate exits 1 with the diagnostic message in the JUnit failure', async () => {
    const junit = tempFile('junit.xml');
    const { code, output } = await cli([path.join(FIXTURES, 'broken.eval.ts'), '--junit', junit]);
    expect(code).toBe(1);
    expect(output).toContain("calledTool('lookup_order') failed: tools called were none");
    expect(fs.readFileSync(junit, 'utf8')).toContain(
      "<failure message=\"calledTool('lookup_order') failed: tools called were none\""
    );
  }, 60_000);
});

describe('loushy eval --record / --replay / --drift (real vitest, mockModel as the "real" provider)', () => {
  const fixture = path.join(FIXTURES, 'replay.eval.ts');
  const cassettes = path.join(FIXTURES, '__cassettes__');
  const cassette = path.join(cassettes, 'recorded-refund', 'plain.json');
  const quietVitest = createVitestSpawner('ignore');
  const cli = (args: string[]) => {
    const log = vi.fn();
    return runEval(args, { log, spawnVitest: quietVitest }).then((code) => ({ code, output: log.mock.calls.map((c) => String(c[0])).join('\n') }));
  };
  const clean = () => fs.rmSync(cassettes, { recursive: true, force: true });

  beforeAll(clean);
  afterAll(clean);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('--replay without a cassette fails the case and names the --record command', async () => {
    const { code, output } = await cli([fixture, '--replay']);
    expect(code).toBe(1);
    expect(output).toContain('no cassette for "recorded refund [plain]"');
    expect(output).toContain(`npx loushy eval --record ${path.relative(process.cwd(), fixture)}`);
  }, 60_000);

  it('--record writes one cassette per case; --replay (or a CI run) replays it with no provider call', async () => {
    expect((await cli([fixture, '--record'])).code).toBe(0);
    expect((JSON.parse(fs.readFileSync(cassette, 'utf8')) as { entries: unknown[] }).entries).toHaveLength(2);

    vi.stubEnv('FIXTURE_PROVIDER', 'offline');
    const json = tempFile('results.json');
    expect((await cli([fixture, '--replay', '--json', json])).code).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(json, 'utf8')) as { results: EvalResult[] };
    expect(parsed.results[0]).toMatchObject({ passed: true, cassettes: [cassette], toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }] });

    vi.stubEnv('CI', 'true');
    expect((await cli([fixture])).code).toBe(0);
    // A plain local run keeps today's behaviour: live, so the offline provider fails it.
    vi.stubEnv('CI', '');
    expect((await cli([fixture])).code).toBe(1);
  }, 120_000);

  it('--drift reports a per-case diff table and JUnit entries, failing only with --strict', async () => {
    const same = await cli([fixture, '--drift']);
    expect(same.code).toBe(0);
    expect(same.output).toContain('Drift: none');

    vi.stubEnv('FIXTURE_ORDER_ID', '43');
    const junit = tempFile('junit.xml');
    const drifted = await cli([fixture, '--drift', '--junit', junit]);
    expect(drifted.code).toBe(0);
    expect(drifted.output).toMatch(/recorded refund\s+plain\s+args\s+lookup_order \{"orderId":"42"\}\s+lookup_order \{"orderId":"43"\}/);
    expect(fs.readFileSync(junit, 'utf8')).toContain('<system-out>soft failure: drift from plain.json: args lookup_order');
    expect(fs.readFileSync(cassette, 'utf8')).toContain('\\"orderId\\":\\"42\\"');

    const strict = await cli([fixture, '--drift', '--strict', '--junit', junit]);
    expect(strict.code).toBe(1);
    expect(fs.readFileSync(junit, 'utf8')).toContain('<failure message="drift from plain.json: args lookup_order');
  }, 120_000);
});
