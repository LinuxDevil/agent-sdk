import { describe, it, expect } from 'vitest';
import { commandEnv } from './commandEnv';

/** A fake host: shell essentials plus planted fake secrets (never real ones). */
const POSIX_HOST = {
  platform: 'linux',
  env: {
    PATH: '/usr/bin',
    HOME: '/home/me',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'xterm',
    CI: '1',
    FAKE_SECRET_FOR_TEST: 'fake-secret-value',
    OPENAI_API_KEY: 'fake-openai-key-for-test',
    UNSET: undefined,
  },
};

const WINDOWS_HOST = {
  platform: 'win32',
  env: {
    Path: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\me',
    TEMP: 'C:\\Temp',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATHEXT: '.COM;.EXE',
    windir: 'C:\\Windows',
    ci: '1',
    FAKE_SECRET_FOR_TEST: 'fake-secret-value',
    ANTHROPIC_API_KEY: 'fake-anthropic-key-for-test',
  },
};

describe('commandEnv (LOU-X11)', () => {
  it('passes only the POSIX base by default, including LC_*', () => {
    expect(commandEnv({}, { host: POSIX_HOST })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TERM: 'xterm',
    });
  });

  it('passes the Windows base by default, matching names case-insensitively', () => {
    expect(commandEnv({}, { host: WINDOWS_HOST })).toEqual({
      Path: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      TEMP: 'C:\\Temp',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      windir: 'C:\\Windows',
    });
    expect(commandEnv({ inheritEnv: ['CI'] }, { host: WINDOWS_HOST }).ci).toBe('1');
    expect(commandEnv({ inheritEnv: ['ci'] }, { host: POSIX_HOST }).CI).toBeUndefined();
  });

  it('adds allowed host names and set values, which win over the host', () => {
    const env = commandEnv({ inheritEnv: ['CI', 'MISSING'], env: { FOO: 'bar', PATH: '/opt/bin' } }, { host: POSIX_HOST });
    expect(env).toMatchObject({ CI: '1', FOO: 'bar', PATH: '/opt/bin', HOME: '/home/me' });
    expect(env).not.toHaveProperty('MISSING');
    expect(JSON.stringify(env)).not.toMatch(/fake-secret-value|fake-openai-key/);
  });

  it('without the base (containers) passes only allowed names and set values', () => {
    expect(commandEnv({ inheritEnv: ['CI'], env: { FOO: 'bar' } }, { base: false, host: POSIX_HOST })).toEqual({ CI: '1', FOO: 'bar' });
    expect(commandEnv({}, { base: false, host: WINDOWS_HOST })).toEqual({});
  });

  it('inheritEnv: true passes the whole host environment (opt-out)', () => {
    const env = commandEnv({ inheritEnv: true, env: { FOO: 'bar' } }, { host: POSIX_HOST });
    expect(env).toMatchObject({ FAKE_SECRET_FOR_TEST: 'fake-secret-value', CI: '1', FOO: 'bar' });
    expect(env).not.toHaveProperty('UNSET');
  });

  it('reads process.env when no host is given', () => {
    process.env.FAKE_SECRET_FOR_TEST = 'fake-secret-value';
    try {
      expect(commandEnv()).not.toHaveProperty('FAKE_SECRET_FOR_TEST');
      expect(commandEnv({ inheritEnv: ['FAKE_SECRET_FOR_TEST'] }).FAKE_SECRET_FOR_TEST).toBe('fake-secret-value');
    } finally {
      delete process.env.FAKE_SECRET_FOR_TEST;
    }
  });
});
