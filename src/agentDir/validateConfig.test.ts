import { describe, it, expect } from 'vitest';
import { permissionRulesOf, validateConfig } from './validateConfig';
import type { PermissionContext } from '../execution/permissions';

const FILE = 'agent.json';
const ctx: PermissionContext = { toolName: 'deploy', toolCallId: 'call-1' };

/** The `when` predicate the single-rule `permissions` config compiles to. */
const whenOf = (permissions: unknown): NonNullable<ReturnType<typeof permissionRulesOf>>[number]['when'] => {
  const config = validateConfig(FILE, { permissions });
  const when = permissionRulesOf(FILE, config.permissions)?.[0]?.when;
  expect(typeof when).toBe('function');
  return when;
};

const invalid = (permissions: unknown): Error => {
  try {
    validateConfig(FILE, { permissions });
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected validateConfig to throw');
};

const invalidConfig = (config: Record<string, unknown>): Error => {
  try {
    validateConfig(FILE, config);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected validateConfig to throw');
};

describe('`when` arg matchers', () => {
  it('keeps a bare string as a regular expression tested against String(arg)', async () => {
    const when = whenOf([{ tool: 'shell', action: 'deny', when: { command: '\\brm\\b' } }]);
    expect(await when?.({ command: 'rm -rf /' }, ctx)).toBe(true);
    expect(await when?.({ command: 'ls -la' }, ctx)).toBe(false);
    expect(await when?.({}, ctx)).toBe(false);
  });

  it('compares `eq` and `ne` with === / !==', async () => {
    const eq = whenOf([{ tool: 'deploy', action: 'allow', when: { environment: { eq: 'staging' } } }]);
    expect(await eq?.({ environment: 'staging' }, ctx)).toBe(true);
    expect(await eq?.({ environment: 'prod' }, ctx)).toBe(false);
    expect(await eq?.({}, ctx)).toBe(false);
    // Strict: a numeric argument does not equal a string operand.
    expect(await eq?.({ environment: 0 }, ctx)).toBe(false);

    const ne = whenOf([{ tool: 'deploy', action: 'deny', when: { environment: { ne: 'prod' } } }]);
    expect(await ne?.({ environment: 'staging' }, ctx)).toBe(true);
    expect(await ne?.({ environment: 'prod' }, ctx)).toBe(false);
    // `!==` holds for a missing argument.
    expect(await ne?.({}, ctx)).toBe(true);
  });

  it.each([
    ['lt', 10, [[9, true], [10, false], [11, false]]],
    ['lte', 10, [[9, true], [10, true], [11, false]]],
    ['gt', 10, [[11, true], [10, false], [9, false]]],
    ['gte', 10, [[11, true], [10, true], [9, false]]],
  ] as const)('compares `%s` on Number(arg)', async (op, operand, cases) => {
    const when = whenOf([{ tool: 'deploy', action: 'deny', when: { replicas: { [op]: operand } } }]);
    for (const [value, expected] of cases) {
      expect(await when?.({ replicas: value }, ctx)).toBe(expected);
      // A numeric string argument is compared by its Number() too.
      expect(await when?.({ replicas: String(value) }, ctx)).toBe(expected);
    }
  });

  it('fails closed on a non-numeric argument for lt/lte/gt/gte', async () => {
    for (const op of ['lt', 'lte', 'gt', 'gte'] as const) {
      const when = whenOf([{ tool: 'deploy', action: 'deny', when: { replicas: { [op]: 10 } } }]);
      for (const value of ['abc', '', '  ', undefined, Number.NaN, {}, [], null, true, 'Infinity']) {
        expect(await when?.({ replicas: value }, ctx), `${op} on ${String(value)}`).toBe(false);
      }
    }
  });

  it('treats `matches` as a regular expression tested against String(arg)', async () => {
    const when = whenOf([{ tool: 'shell', action: 'deny', when: { command: { matches: '^rm\\b' } } }]);
    expect(await when?.({ command: 'rm -rf /' }, ctx)).toBe(true);
    expect(await when?.({ command: 'echo rm' }, ctx)).toBe(false);
    expect(await when?.({}, ctx)).toBe(false);
  });

  it('ANDs operators within one argument and matchers across arguments', async () => {
    const range = whenOf([{ tool: 'deploy', action: 'deny', when: { replicas: { gte: 1, lte: 10 } } }]);
    expect(await range?.({ replicas: 5 }, ctx)).toBe(true);
    expect(await range?.({ replicas: 0 }, ctx)).toBe(false);
    expect(await range?.({ replicas: 11 }, ctx)).toBe(false);

    const both = whenOf([
      { tool: 'deploy', action: 'deny', when: { environment: { eq: 'staging' }, replicas: { gt: 10 } } },
    ]);
    expect(await both?.({ environment: 'staging', replicas: 12 }, ctx)).toBe(true);
    expect(await both?.({ environment: 'staging', replicas: 5 }, ctx)).toBe(false);
    expect(await both?.({ environment: 'prod', replicas: 12 }, ctx)).toBe(false);
  });

  it('rejects an unknown operator, naming it', () => {
    const error = invalid([{ tool: 'deploy', action: 'deny', when: { replicas: { roughly: 10 } } }]);
    expect(error.message).toContain(FILE);
    expect(error.message).toContain("'permissions[0]'.when.replicas.roughly is not a known operator");
    expect(error.message).toContain('eq, ne, lt, lte, gt, gte, matches');
  });

  it('rejects ill-typed operands and invalid expressions, per entry', () => {
    expect(invalid([{ tool: 't', action: 'deny', when: { replicas: { lt: 'ten' } } }]).message).toContain(
      "'permissions[0]'.when.replicas.lt must be a finite number"
    );
    expect(invalid([{ tool: 't', action: 'deny', when: { command: { matches: 3 } } }]).message).toContain(
      "'permissions[0]'.when.command.matches must be a regular expression string"
    );
    expect(invalid([{ tool: 't', action: 'deny', when: { env: { eq: { nested: true } } } }]).message).toContain(
      "'permissions[0]'.when.env.eq must be a string, number, boolean or null"
    );
    expect(invalid([{ tool: 't', action: 'deny', when: { command: { matches: '(' } } }]).message).toMatch(
      /'permissions\[0\]'\.when\.command\.matches is not a valid regular expression/
    );
    expect(invalid([{ tool: 't', action: 'deny', when: { command: '(' } }]).message).toMatch(
      /'permissions\[0\]'\.when\.command is not a valid regular expression/
    );
    expect(invalid([{ tool: 't', action: 'deny', when: { command: {} } }]).message).toContain(
      "'permissions[0]'.when.command must be a regular expression or an operator object"
    );
    expect(invalid([{ tool: 't', action: 'deny', when: { command: 5 } }]).message).toContain(
      "'permissions[0]'.when.command must be a regular expression or an operator object"
    );
    expect(invalid([{ tool: 't', action: 'deny', when: {} }]).message).toContain(
      "'permissions[0]'.when must name at least one argument"
    );
    expect(invalid([{ tool: 't', action: 'deny', when: 'rm' }]).message).toContain(
      "'permissions[0]'.when must be a predicate (a code config) or a record of argument names to matchers"
    );
  });
});

describe('approvalTtlMs and permission-rule ttlMs', () => {
  it('accepts a positive finite approvalTtlMs', () => {
    expect(validateConfig(FILE, { approvalTtlMs: 60_000 }).approvalTtlMs).toBe(60_000);
    expect(validateConfig(FILE, {}).approvalTtlMs).toBeUndefined();
  });

  it('rejects a non-positive, non-finite or non-numeric approvalTtlMs', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '60000', null, true]) {
      expect(invalidConfig({ approvalTtlMs: value }).message, String(value)).toContain(
        "'approvalTtlMs' must be a positive number of milliseconds"
      );
    }
  });

  it("carries an ask rule's ttlMs into the assembled PermissionRule", () => {
    const rules = permissionRulesOf(
      FILE,
      validateConfig(FILE, { permissions: [{ tool: 'deploy', action: 'ask', ttlMs: 600_000 }] }).permissions
    );
    expect(rules).toEqual([{ tool: 'deploy', action: 'ask', ttlMs: 600_000 }]);
    // Unset, the key is absent so the run's approvalTtlMs applies.
    const noTtl = permissionRulesOf(FILE, validateConfig(FILE, { permissions: [{ tool: 'deploy', action: 'ask' }] }).permissions);
    expect(noTtl?.[0]).not.toHaveProperty('ttlMs');
  });

  it("rejects ttlMs on non-'ask' rules and non-positive values", () => {
    expect(invalidConfig({ permissions: [{ tool: 'x', action: 'deny', ttlMs: 1000 }] }).message).toContain(
      "'permissions[0]'.ttlMs only applies to 'ask' rules"
    );
    expect(invalidConfig({ permissions: [{ tool: 'x', action: 'allow', ttlMs: 1000 }] }).message).toContain(
      "only applies to 'ask' rules"
    );
    for (const value of [0, -1, Number.NaN, '60000']) {
      expect(invalidConfig({ permissions: [{ tool: 'x', action: 'ask', ttlMs: value }] }).message, String(value)).toContain(
        "'permissions[0]'.ttlMs must be a positive number of milliseconds"
      );
    }
  });
});

describe('store', () => {
  it('accepts a file-store options object, including historyLimit and tokenKey', () => {
    expect(validateConfig(FILE, { store: { dir: './.lousho' } }).store).toEqual({ dir: './.lousho' });
    expect(validateConfig(FILE, { store: { dir: 'data', historyLimit: 0, tokenKey: 'a2V5' } }).store).toEqual({
      dir: 'data',
      historyLimit: 0,
      tokenKey: 'a2V5',
    });
    expect(validateConfig(FILE, {}).store).toBeUndefined();
  });

  it('accepts an AgentStore instance (a code config), extra keys ignored', () => {
    const store = {
      sessions: { load: async () => [], save: async () => {}, delete: async () => {} },
      approvals: { save: async () => {}, resolve: async () => null },
      close: () => {},
    };
    expect(validateConfig(FILE, { store }).store).toBe(store);
  });

  it('rejects bad store values, naming the problem', () => {
    expect(invalidConfig({ store: './.lousho' }).message).toContain(
      `'store' must be a file-store options object like { "dir": "./.lousho" }`
    );
    expect(invalidConfig({ store: {} }).message).toContain(
      `'store' must be a file-store options object like { "dir": "./.lousho" }`
    );
    for (const value of [{ dir: '' }, { dir: 5 }]) {
      expect(invalidConfig({ store: value }).message, JSON.stringify(value)).toContain(
        "'store.dir' must be a non-empty string"
      );
    }
    expect(invalidConfig({ store: { dir: 'x', sessions: {} } }).message).toContain("unknown key(s) sessions");
    expect(invalidConfig({ store: { dir: 'x', historyLimit: -1 } }).message).toContain(
      "'store.historyLimit' must be a non-negative integer"
    );
    expect(invalidConfig({ store: { dir: 'x', tokenKey: 3 } }).message).toContain(
      "'store.tokenKey' must be a base64 key string or a list of them"
    );
    expect(invalidConfig({ store: { sessions: {} } }).message).toContain("'store.sessions' must be a store (an object with load())");
    expect(invalidConfig({ store: { path: './.lousho' } }).message).toContain('or - in a code config - an AgentStore');
  });
});

describe('modelSettings (C6)', () => {
  it('accepts the known sampling settings', () => {
    const modelSettings = { maxTokens: 1024, temperature: 0.2, topP: 0.9, frequencyPenalty: 0, presencePenalty: 0.1, stop: ['END'], seed: 7 };
    expect(validateConfig(FILE, { modelSettings }).modelSettings).toEqual(modelSettings);
  });

  it('rejects unknown keys and ill-typed values, naming them', () => {
    expect(invalidConfig({ modelSettings: 1024 }).message).toContain("'modelSettings' must be an object");
    expect(invalidConfig({ modelSettings: { maxOutputTokens: 10 } }).message).toContain("'modelSettings.maxOutputTokens' is not a known setting");
    expect(invalidConfig({ modelSettings: { temperature: '0.2' } }).message).toContain("'modelSettings.temperature' must be a number");
    expect(invalidConfig({ modelSettings: { stop: 'END' } }).message).toContain("'modelSettings.stop' must be an array of strings");
  });
});
