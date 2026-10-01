import { describe, expect, it } from 'vitest';
import { InitUsageError, detectPackageManager, expectOneOf, parseInitArgs } from './options';

describe('parseInitArgs', () => {
  it('defaults: nothing given, install and git on', () => {
    expect(parseInitArgs([], {})).toEqual({
      help: false,
      dir: undefined,
      provider: undefined,
      template: undefined,
      packageManager: undefined,
      yes: false,
      install: true,
      git: true,
      force: false,
      sdkPath: undefined,
    });
  });

  it('parses every flag and the positional directory', () => {
    const options = parseInitArgs(
      ['my-agent', '--provider', 'anthropic', '--template=tools', '-y', '--no-install', '--no-git', '--force', '--package-manager', 'pnpm', '--sdk-path', './sdk'],
      {}
    );
    expect(options).toMatchObject({
      dir: 'my-agent',
      provider: 'anthropic',
      template: 'tools',
      yes: true,
      install: false,
      git: false,
      force: true,
      packageManager: 'pnpm',
      sdkPath: './sdk',
    });
  });

  it('reads the SDK path from LOUSHY_SDK_PATH, with the flag taking precedence', () => {
    expect(parseInitArgs([], { LOUSHY_SDK_PATH: '/env/sdk' }).sdkPath).toBe('/env/sdk');
    expect(parseInitArgs(['--sdk-path=/flag/sdk'], { LOUSHY_SDK_PATH: '/env/sdk' }).sdkPath).toBe('/flag/sdk');
  });

  it('rejects unknown flags and more than one directory', () => {
    expect(() => parseInitArgs(['--bogus'], {})).toThrow(InitUsageError);
    expect(() => parseInitArgs(['--bogus'], {})).toThrow(/--bogus/);
    expect(() => parseInitArgs(['a', 'b'], {})).toThrow(/at most one directory/);
  });
});

describe('expectOneOf', () => {
  it('passes allowed values through and names the flag and choices otherwise', () => {
    expect(expectOneOf('--template', 'tools', ['minimal', 'tools'])).toBe('tools');
    expect(() => expectOneOf('--template', 'nope', ['minimal', 'tools'])).toThrow(
      "invalid --template 'nope'. Allowed values: minimal, tools."
    );
  });
});

describe('detectPackageManager', () => {
  it.each([
    ['pnpm/9.1.0 npm/? node/v22.19.0 linux x64', 'pnpm'],
    ['yarn/1.22.22 npm/? node/v22.19.0 linux x64', 'yarn'],
    ['bun/1.1.0 npm/? node/v22.19.0 linux x64', 'bun'],
    ['npm/10.9.0 node/v22.19.0 linux x64 workspaces/false', 'npm'],
    ['something-else/1.0.0', 'npm'],
    [undefined, 'npm'],
  ])('%s -> %s', (agent, expected) => {
    expect(detectPackageManager({ npm_config_user_agent: agent })).toBe(expected);
  });
});
