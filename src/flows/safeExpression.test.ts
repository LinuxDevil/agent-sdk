import { describe, it, expect } from 'vitest';
import { evaluateSafeExpression, ExpressionError } from './safeExpression';

const scope = {
  score: 85,
  name: 'Ada Lovelace',
  tags: ['vip', 'beta'],
  empty: '',
  nothing: null,
  flag: true,
  user: { age: 36, address: { city: 'London' }, 'first-name': 'Ada', list: [{ id: 7 }] },
  key: 'age',
  output: { sentiment: 'positive' },
};

describe('evaluateSafeExpression: supported forms', () => {
  const cases: Array<[string, unknown]> = [
    // literals
    ["'hello'", 'hello'],
    ['"hello"', 'hello'],
    ["'it\\'s'", "it's"],
    ["'a\\nb'", 'a\nb'],
    ['42', 42],
    ['1.5', 1.5],
    ['true', true],
    ['false', false],
    ['null', null],
    // variables and paths
    ['score', 85],
    ['user.age', 36],
    ['user.address.city', 'London'],
    ["user['first-name']", 'Ada'],
    ['user[key]', 36],
    ['tags[0]', 'vip'],
    ['tags[5]', undefined],
    ['user.list[0].id', 7],
    ['user.missing', undefined],
    ['name[0]', 'A'],
    // length
    ['name.length', 12],
    ['tags.length', 2],
    ['tags.length > 1', true],
    // comparison
    ['score == 85', true],
    ["score == '85'", true],
    ["score === '85'", false],
    ['score === 85', true],
    ['score != 85', false],
    ['score !== 86', true],
    ['score < 90', true],
    ['score <= 85', true],
    ['score > 85', false],
    ['score >= 85', true],
    ["name < 'B'", true],
    ['nothing == null', true],
    ['nothing === null', true],
    ['output.sentiment === "positive"', true],
    // logical
    ['score > 80 && flag', true],
    ['score > 90 || flag', true],
    ['score > 90 || score < 50', false],
    ["empty || 'fallback'", 'fallback'],
    ["flag && 'yes'", 'yes'],
    ['!flag', false],
    ['!nothing', true],
    ['!!name', true],
    ['!(score > 90)', true],
    // precedence and grouping
    ['true || false && false', true],
    ['(true || false) && false', false],
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['score > 80 && score < 90', true],
    // arithmetic
    ['score + 15', 100],
    ['score - 5', 80],
    ['score * 2', 170],
    ['score / 5', 17],
    ['score % 10', 5],
    ['-score', -85],
    ['+score', 85],
    ['10 - 2 - 3', 5],
    ["'a' + 'b'", 'ab'],
    // allow-listed methods
    ["name.includes('Love')", true],
    ["name.includes('xyz')", false],
    ["name.startsWith('Ada')", true],
    ["name.endsWith('lace')", true],
    ["name.endsWith('Ada')", false],
    ["tags.includes('vip')", true],
    ["tags.includes('gold')", false],
    ["tags.includes('vip') && score >= 80", true],
    // whitespace tolerance and empty
    ['  score   >=   80  ', true],
    ['', undefined],
    ['   ', undefined],
    // shapes the Agent Forge router generates after {{var}} interpolation
    ["'refund' === 'refund'", true],
    ['95 >= 90', true],
    ['5 > 5', false],
  ];

  it.each(cases)('%s', (expression, expected) => {
    expect(evaluateSafeExpression(expression, scope)).toStrictEqual(expected);
  });

  it('short-circuits so the unevaluated side cannot fail', () => {
    expect(evaluateSafeExpression('flag || missingVar', scope)).toBe(true);
    expect(evaluateSafeExpression('nothing && missingVar', scope)).toBe(null);
  });

  it('only exposes own properties (no prototype members)', () => {
    expect(evaluateSafeExpression('user.toString', scope)).toBe(undefined);
    expect(evaluateSafeExpression('user.hasOwnProperty', scope)).toBe(undefined);
  });
});

describe('evaluateSafeExpression: rejected syntax', () => {
  const rejected: Array<[string, RegExp]> = [
    ['process.exit()', /unknown variable 'process'/],
    ["require('fs')", /function calls are not supported/],
    ["constructor.constructor('return process')()", /function calls are not supported/],
    ["user.constructor.constructor('return process')()", /function calls are not supported/],
    ['constructor.constructor', /unknown variable 'constructor'/],
    ['user.constructor.constructor', /access to 'constructor' is not allowed/],
    ["user['constructor']", /access to 'constructor' is not allowed/],
    ['user.__proto__', /access to '__proto__' is not allowed/],
    ['tags.__proto__.x', /access to '__proto__' is not allowed/],
    ['name.prototype', /access to 'prototype' is not allowed/],
    ['globalThis', /unknown variable 'globalThis'/],
    ['globalThis.process', /unknown variable 'globalThis'/],
    ['window', /unknown variable 'window'/],
    ['score = 1', /assignment is not supported/],
    ["user.age = 'x'", /assignment is not supported/],
    ['score += 1', /assignment is not supported/],
    ['score++', /unexpected/],
    ["eval('1')", /function calls are not supported/],
    ['score()', /function calls are not supported/],
    ['name.toUpperCase()', /method 'toUpperCase' is not allowed/],
    ["name['constructor']('x')", /method 'constructor' is not allowed/],
    ["name.replace('a', 'b')", /method 'replace' is not allowed/],
    ['tags.map(x)', /method 'map' is not allowed/],
    ["tags.startsWith('v')", /only applies to strings/],
    ['name.includes()', /exactly one argument/],
    ['name.includes(1)', /needs a string argument/],
    ['name.toString', /not available on strings/],
    ['`template`', /unexpected character/],
    ['a ? b : c', /unexpected character/],
    ['score;', /unexpected character/],
    ['{}', /unexpected character/],
    ['(score', /expected '\)'/],
    ['score >', /unexpected end of expression/],
    ['score score', /unexpected 'score'/],
    ["'unterminated", /unterminated string/],
    ["'bad\\x'", /unsupported escape/],
    ['user.', /expected a property name/],
    ['user[0', /expected '\]'/],
    ['user > 1', /only apply to strings, numbers, booleans and null/],
    ['unknownVar', /unknown variable 'unknownVar'/],
    ['nothing.x', /cannot read 'x' of null/],
    ['score.x', /cannot read 'x' of a number/],
  ];

  it.each(rejected)('%s', (expression, pattern) => {
    expect(() => evaluateSafeExpression(expression, scope)).toThrow(ExpressionError);
    expect(() => evaluateSafeExpression(expression, scope)).toThrow(pattern);
  });

  it('names the expression, position and supported grammar', () => {
    let error: ExpressionError | undefined;
    try {
      evaluateSafeExpression('score > 1 && process.exit()', scope);
    } catch (e) {
      error = e as ExpressionError;
    }
    expect(error).toBeInstanceOf(ExpressionError);
    expect(error?.expression).toBe('score > 1 && process.exit()');
    expect(error?.position).toBe(13);
    expect(error?.message).toContain('Invalid expression "score > 1 && process.exit()" at position 13');
    expect(error?.message).toContain('Supported:');
  });

  it('does not run injected code or mutate the scope', () => {
    const marker = { ran: false };
    expect(() => evaluateSafeExpression('marker.ran = true', { marker })).toThrow(ExpressionError);
    expect(marker.ran).toBe(false);
  });

  it('rejects absurdly nested input instead of overflowing the stack', () => {
    const deep = '('.repeat(5000) + '1' + ')'.repeat(5000);
    expect(() => evaluateSafeExpression(deep, scope)).toThrow(/nested too deeply/);
    expect(() => evaluateSafeExpression('!'.repeat(5000) + 'flag', scope)).toThrow(/nested too deeply/);
  });
});
