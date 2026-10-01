import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildEnvironment, parseDoctorArgs, runDoctorCommand } from './doctor';
import { satisfiesRange } from './versionRange';

describe('satisfiesRange', () => {
  it.each([
    ['22.19.0', '>=22.19.0', true],
    ['22.18.9', '>=22.19.0', false],
    ['v23.0.0', '>=22.19.0', true],
    ['4.9.0', '^4.3.19', true],
    ['5.0.0', '^4.3.19', false],
    ['0.0.42', '^0.0.42', true],
    ['0.0.43', '^0.0.42', false],
    ['0.2.9', '^0.2.1', true],
    ['0.3.0', '^0.2.1', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.3', '1.2.3', true],
    ['2.0.0', '^1.0.0 || ^2.0.0', true],
    ['3.0.0', '^1.0.0 || ^2.0.0', false],
    ['1.0.0', '*', true],
    ['garbage', '^1.0.0', false],
  ])('%s vs %s -> %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});

describe('parseDoctorArgs', () => {
  it('reads the spec path and --json', () => {
    expect(parseDoctorArgs(['agent.yaml', '--json'])).toEqual({ specPath: 'agent.yaml', json: true });
    expect(parseDoctorArgs([])).toEqual({ specPath: undefined, json: false });
  });
});

describe('real environment', () => {
  it('resolves installed packages from cwd and reports missing ones', () => {
    const env = buildEnvironment({ json: false });
    expect(env.resolvePackageVersion('zod')).toMatch(/^\d+\.\d+\.\d+/);
    expect(env.resolvePackageVersion('definitely-not-installed-pkg')).toBeNull();
    expect(env.sdk.engines?.node).toBeTruthy();
  });

  it('finds commands by path and on PATH', () => {
    const env = buildEnvironment({ json: false });
    expect(env.commandExists(process.execPath)).toBe(true);
    expect(env.commandExists('node')).toBe(true);
    expect(env.commandExists('definitely-not-a-command-xyz')).toBe(false);
  });

  it('loads a spec file and its raw mcpServers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-doctor-'));
    fs.writeFileSync(
      path.join(dir, 'a.yaml'),
      'name: bot\nprompt: hi\nprovider:\n  type: mock\n  model: m\nmcpServers:\n  fs:\n    command: npx\n'
    );
    fs.writeFileSync(path.join(dir, 'a.json'), '{"mcpServers":{}}');
    const env = buildEnvironment({ json: false, specPath: 'a.yaml' }, dir);
    expect(env.specPath).toBe(path.join(dir, 'a.yaml'));
    expect(env.loadSpec(env.specPath as string).name).toBe('bot');
    expect(env.readRawSpec(env.specPath as string)).toMatchObject({ mcpServers: { fs: { command: 'npx' } } });
    expect(env.readRawSpec(path.join(dir, 'a.json'))).toEqual({ mcpServers: {} });
    expect(env.resolveTool('http')).toBeTruthy();
    expect(() => env.resolveTool('nope')).toThrow();
  });
});

describe('runDoctorCommand', () => {
  it('prints text and returns the exit code; --json prints JSON', async () => {
    const env = buildEnvironment({ json: false });
    const fakeEnv = {
      ...env,
      nodeVersion: '1.0.0',
      dockerReachable: async () => false,
      fetch: async () => ({ ok: true, status: 200 }),
    };
    const out: string[] = [];
    expect(await runDoctorCommand([], fakeEnv, (t) => out.push(t))).toBe(1);
    expect(out[0]).toContain('[FAIL] Node.js');

    const json: string[] = [];
    await runDoctorCommand(['--json'], fakeEnv, (t) => json.push(t));
    expect(JSON.parse(json[0]).exitCode).toBe(1);
  });

  it('uses console.log by default', async () => {
    const env = buildEnvironment({ json: false });
    const lines: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(...args);
    try {
      await runDoctorCommand([], { ...env, dockerReachable: async () => false });
    } finally {
      console.log = original;
    }
    expect(String(lines[0])).toContain('loushy doctor');
  });
});
