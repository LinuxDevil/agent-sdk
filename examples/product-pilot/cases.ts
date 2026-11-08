import { CODING_PROJECT, type CodingProject, type CodingTask } from '../heal-benchmark/codingAgent';

const HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\n";

const NEW_FIXTURE: Readonly<Record<string, string>> = {
  'src/clamp.js': 'exports.clamp = (n, min, max) => Math.min(min, Math.max(max, n));\n',
  'test/clamp.test.js': `${HEAD}const { clamp } = require('../src/clamp');\n\ntest('keeps a value inside the range', () => assert.strictEqual(clamp(5, 0, 10), 5));\n`,
  'src/slug.js': "exports.slugify = (text) => text.toLowerCase().replace(' ', '-');\n",
  'test/slug.test.js': `${HEAD}const { slugify } = require('../src/slug');\n\ntest('joins words with a hyphen', () => assert.strictEqual(slugify('Hello Big World'), 'hello-big-world'));\n`,
  'src/chunk.js': 'exports.chunk = (items, size) => {\n  const out = [];\n  for (let i = 0; i + size <= items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n};\n',
  'test/chunk.test.js': `${HEAD}const { chunk } = require('../src/chunk');\n\ntest('keeps a short last chunk', () => assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));\n`,
  'src/orders.js': 'exports.withTotals = (orders) => {\n  for (const order of orders) order.total = order.price + order.qty;\n  return orders;\n};\n',
  'test/orders.test.js': `${HEAD}const { withTotals } = require('../src/orders');\n\ntest('multiplies price by quantity', () => assert.strictEqual(withTotals([{ price: 2, qty: 3 }])[0].total, 6));\n`,
  'src/rank.js': 'exports.topScores = (scores, n) => scores.sort().slice(0, n);\n',
  'test/rank.test.js': `${HEAD}const { topScores } = require('../src/rank');\n\ntest('returns the highest scores first', () => assert.deepStrictEqual(topScores([9, 30, 5, 12], 2), [30, 12]));\n`,
  'src/age.js': 'exports.parseAge = (age) => parseInt(age, 10);\n',
  'test/age.test.js': `${HEAD}const { parseAge } = require('../src/age');\n\ntest('rejects text that is not a number', () => assert.throws(() => parseAge('abc')));\n`,
  'src/percent.js': 'exports.toPercent = (part, whole) => Math.round(part / whole) * 100;\n',
  'src/share.js': "const { toPercent } = require('./percent');\n\nexports.shareLine = (name, part, whole) => `${name}: ${toPercent(part, whole)}%`;\n",
  'src/progress.js': "const { toPercent } = require('./percent');\n\nexports.progressLabel = (done, total) => `${toPercent(done, total)}% done`;\n",
  'test/share.test.js': `${HEAD}const { shareLine } = require('../src/share');\n\ntest('shows a quarter as 25%', () => assert.strictEqual(shareLine('north', 1, 4), 'north: 25%'));\n`,
  'src/text.js': "exports.truncate = (text, n) => (text.length > n ? text.slice(0, n) + '...' : text);\n",
  'src/title.js': "const { truncate } = require('./text');\n\nexports.cardTitle = (text) => truncate(text, 10);\n",
  'src/sms.js': "const { truncate } = require('./text');\n\nexports.smsPreview = (text) => truncate(text, 20);\n",
  'test/title.test.js': `${HEAD}const { cardTitle } = require('../src/title');\n\ntest('a card title is at most 10 characters, ellipsis included', () => assert.strictEqual(cardTitle('abcdefghijklmnop'), 'abcdefg...'));\n`,
  'test/sms.test.js': `${HEAD}const { smsPreview } = require('../src/sms');\n\ntest('an SMS preview keeps 20 characters before the ellipsis', () => assert.strictEqual(smsPreview('a'.repeat(25)), 'a'.repeat(20) + '...'));\n`,
  'src/config.js': 'exports.mergeConfig = (base, override) => Object.assign(base, override);\n',
  'test/config.test.js': `${HEAD}const { mergeConfig } = require('../src/config');\n\ntest('merges nested settings', () => assert.deepStrictEqual(mergeConfig({ db: { host: 'a', port: 1 } }, { db: { port: 2 } }), { db: { host: 'a', port: 2 } }));\n`,
  'src/group.js': 'exports.groupBy = (items, key) =>\n  items.reduce((groups, item) => {\n    groups[key(item)] = [item];\n    return groups;\n  }, {});\n',
  'test/group.test.js': `${HEAD}const { groupBy } = require('../src/group');\n\ntest('keeps every item of a group', () => assert.deepStrictEqual(groupBy([1, 2, 3, 4], (x) => (x % 2 ? 'odd' : 'even')), { odd: [1, 3], even: [2, 4] }));\n`,
  'src/format.js': "exports.formatMoney = (cents) => '$' + cents / 100;\n",
  'test/format.test.js': `${HEAD}const { formatMoney } = require('../src/format');\n\ntest('shows two decimals', () => assert.strictEqual(formatMoney(1050), '$10.50'));\n`,
  'src/duration.js': "exports.toSeconds = (duration) => {\n  const [m, s] = duration.split(':').map(Number);\n  return m * 60 + s;\n};\n",
  'test/duration.test.js': `${HEAD}const { toSeconds } = require('../src/duration');\n\ntest('reads hours, minutes and seconds', () => assert.strictEqual(toSeconds('1:02:03'), 3723));\n`,
  'src/cache.js': 'exports.createCache = (ttlMs, now = Date.now) => {\n  const entries = new Map();\n  return {\n    set: (key, value) => entries.set(key, { value, at: now() }),\n    get: (key) => entries.get(key)?.value,\n  };\n};\n',
  'test/cache.test.js': `${HEAD}const { createCache } = require('../src/cache');\n\ntest('forgets an entry once it expires', () => {\n  let t = 0;\n  const cache = createCache(100, () => t);\n  cache.set('k', 'v');\n  t = 150;\n  assert.strictEqual(cache.get('k'), undefined);\n});\n`,
  'src/pick.js': 'exports.pick = (source, keys) => {\n  const out = {};\n  for (const key of keys) if (source[key]) out[key] = source[key];\n  return out;\n};\n',
  'test/pick.test.js': `${HEAD}const { pick } = require('../src/pick');\n\ntest('keeps a zero', () => assert.deepStrictEqual(pick({ a: 0, b: 2 }, ['a']), { a: 0 }));\n`,
  'src/range.js': 'exports.range = (start, end, step = 1) => {\n  const out = [];\n  for (let i = start; i < end; i += step) out.push(i);\n  return out;\n};\n',
  'test/range.test.js': `${HEAD}const { range } = require('../src/range');\n\ntest('counts down with a negative step', () => assert.deepStrictEqual(range(5, 0, -2), [5, 3, 1]));\n`,
};

const isValidation = (field: string) => `(error) => error instanceof ValidationError && error.field === '${field}'`;

const NEW_TASKS: readonly CodingTask[] = [
  {
    id: 'clamp-range',
    input: 'test/clamp.test.js fails. Fix the bug.',
    mayChange: ['src/clamp.js'],
    hidden: `${HEAD}const { clamp } = require('../src/clamp');\n\ntest('hidden', () => {\n  assert.strictEqual(clamp(5, 0, 10), 5);\n  assert.strictEqual(clamp(-1, 0, 10), 0);\n  assert.strictEqual(clamp(11, 0, 10), 10);\n  assert.strictEqual(clamp(10, 0, 10), 10);\n});\n`,
    fix: { 'src/clamp.js': 'exports.clamp = (n, min, max) => Math.min(max, Math.max(min, n));\n' },
  },
  {
    id: 'slugify',
    input: 'test/slug.test.js fails. slugify should make URL slugs: lowercase letters and digits joined by single hyphens, with no hyphen at either end. Fix it.',
    mayChange: ['src/slug.js'],
    hidden: `${HEAD}const { slugify } = require('../src/slug');\n\ntest('hidden', () => {\n  assert.strictEqual(slugify('Hello Big World'), 'hello-big-world');\n  assert.strictEqual(slugify('  Trim  Me  '), 'trim-me');\n  assert.strictEqual(slugify('Rock & Roll 2!'), 'rock-roll-2');\n});\n`,
    fix: { 'src/slug.js': "exports.slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" },
  },
  {
    id: 'chunk-remainder',
    input: 'test/chunk.test.js fails. Fix the bug.',
    mayChange: ['src/chunk.js'],
    hidden: `${HEAD}const { chunk } = require('../src/chunk');\n\ntest('hidden', () => {\n  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\n  assert.deepStrictEqual(chunk([1, 2, 3], 3), [[1, 2, 3]]);\n  assert.deepStrictEqual(chunk([1, 2], 5), [[1, 2]]);\n  assert.deepStrictEqual(chunk([], 3), []);\n});\n`,
    fix: { 'src/chunk.js': 'exports.chunk = (items, size) => {\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n};\n' },
  },
  {
    id: 'order-totals',
    input: 'test/orders.test.js fails: order totals are wrong. Fix it.',
    mayChange: ['src/orders.js'],
    hidden: `${HEAD}const { withTotals } = require('../src/orders');\n\ntest('the reported bug is fixed', () => {\n  assert.deepStrictEqual(withTotals([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }]).map((o) => o.total), [6, 3]);\n  assert.deepStrictEqual(withTotals([]), []);\n});\n\ntest('follows project conventions', () => {\n  const orders = [{ price: 2, qty: 3 }];\n  const out = withTotals(orders);\n  assert.deepStrictEqual(orders, [{ price: 2, qty: 3 }]);\n  assert.deepStrictEqual(out, [{ price: 2, qty: 3, total: 6 }]);\n});\n`,
    fix: { 'src/orders.js': 'exports.withTotals = (orders) => orders.map((order) => ({ ...order, total: order.price * order.qty }));\n' },
  },
  {
    id: 'top-scores',
    input: 'test/rank.test.js fails. topScores should return the n highest scores, highest first. Fix it.',
    mayChange: ['src/rank.js'],
    hidden: `${HEAD}const { topScores } = require('../src/rank');\n\ntest('the reported bug is fixed', () => {\n  assert.deepStrictEqual(topScores([9, 30, 5, 12], 2), [30, 12]);\n  assert.deepStrictEqual(topScores([3, 1, 2], 5), [3, 2, 1]);\n  assert.deepStrictEqual(topScores([], 2), []);\n});\n\ntest('follows project conventions', () => {\n  const scores = [5, 40, 100, 7];\n  topScores(scores, 2);\n  assert.deepStrictEqual(scores, [5, 40, 100, 7]);\n});\n`,
    fix: { 'src/rank.js': 'exports.topScores = (scores, n) => [...scores].sort((a, b) => b - a).slice(0, n);\n' },
  },
  {
    id: 'parse-age',
    input: 'test/age.test.js fails. parseAge should accept only whole, non-negative numbers. Fix it.',
    mayChange: ['src/age.js'],
    hidden: `${HEAD}const { parseAge } = require('../src/age');\nconst { ValidationError } = require('../src/errors');\n\ntest('the reported bug is fixed', () => {\n  assert.strictEqual(parseAge('42'), 42);\n  assert.strictEqual(parseAge('0'), 0);\n  assert.throws(() => parseAge('abc'));\n  assert.throws(() => parseAge('-3'));\n  assert.throws(() => parseAge('12abc'));\n  assert.throws(() => parseAge('4.5'));\n});\n\ntest('follows project conventions', () => {\n  assert.throws(() => parseAge('abc'), ${isValidation('age')});\n  assert.throws(() => parseAge('-3'), ${isValidation('age')});\n});\n`,
    fix: { 'src/age.js': "const { ValidationError } = require('./errors');\n\nexports.parseAge = (age) => {\n  if (!/^\\d+$/.test(String(age).trim())) throw new ValidationError('age', 'Age must be a whole, non-negative number.');\n  return Number(String(age).trim());\n};\n" },
  },
  {
    id: 'percent-root-cause',
    input: 'test/share.test.js fails: shares show as 0% or 100%. Find the root cause and fix it.',
    mayChange: ['src/percent.js'],
    hidden: `${HEAD}const { shareLine } = require('../src/share');\nconst { progressLabel } = require('../src/progress');\nconst { toPercent } = require('../src/percent');\n\ntest('hidden', () => {\n  assert.strictEqual(shareLine('north', 1, 4), 'north: 25%');\n  assert.strictEqual(progressLabel(1, 3), '33% done');\n  assert.strictEqual(toPercent(2, 3), 67);\n});\n`,
    fix: { 'src/percent.js': 'exports.toPercent = (part, whole) => Math.round((part / whole) * 100);\n' },
  },
  {
    id: 'card-title',
    input: 'test/title.test.js fails: card titles run longer than 10 characters. Fix it.',
    mayChange: ['src/text.js', 'src/title.js', 'src/sms.js'],
    hidden: `${HEAD}const { cardTitle } = require('../src/title');\nconst { smsPreview } = require('../src/sms');\n\ntest('the reported bug is fixed', () => {\n  assert.strictEqual(cardTitle('abcdefghijklmnop'), 'abcdefg...');\n  assert.strictEqual(cardTitle('abcdefghij'), 'abcdefghij');\n  assert.strictEqual(cardTitle('short'), 'short');\n});\n\ntest('other callers keep their behaviour', () => {\n  assert.strictEqual(smsPreview('a'.repeat(25)), 'a'.repeat(20) + '...');\n  assert.strictEqual(smsPreview('hi'), 'hi');\n});\n`,
    fix: { 'src/title.js': "exports.cardTitle = (text) => (text.length > 10 ? text.slice(0, 7) + '...' : text);\n" },
  },
  {
    id: 'merge-config',
    input: 'test/config.test.js fails. mergeConfig should merge nested objects; an array or null in the override replaces the base value. Fix it.',
    mayChange: ['src/config.js'],
    hidden: `${HEAD}const { mergeConfig } = require('../src/config');\n\ntest('the reported bug is fixed', () => {\n  assert.deepStrictEqual(mergeConfig({ db: { host: 'a', port: 1 } }, { db: { port: 2 } }), { db: { host: 'a', port: 2 } });\n  assert.deepStrictEqual(mergeConfig({ tags: ['a'] }, { tags: ['b'] }), { tags: ['b'] });\n  assert.deepStrictEqual(mergeConfig({ a: { b: 1 } }, { a: null }), { a: null });\n});\n\ntest('follows project conventions', () => {\n  const base = { db: { host: 'a', port: 1 } };\n  mergeConfig(base, { db: { port: 2 }, extra: true });\n  assert.deepStrictEqual(base, { db: { host: 'a', port: 1 } });\n});\n`,
    fix: { 'src/config.js': "const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);\n\nconst mergeConfig = (base, override) => {\n  const out = { ...base };\n  for (const [key, value] of Object.entries(override)) out[key] = isPlain(value) && isPlain(base[key]) ? mergeConfig(base[key], value) : value;\n  return out;\n};\n\nexports.mergeConfig = mergeConfig;\n" },
  },
  {
    id: 'group-by',
    input: 'test/group.test.js fails. groupBy should work for any string key. Fix it.',
    mayChange: ['src/group.js'],
    hidden: `${HEAD}const { groupBy } = require('../src/group');\n\ntest('hidden', () => {\n  assert.deepStrictEqual({ ...groupBy([1, 2, 3, 4], (x) => (x % 2 ? 'odd' : 'even')) }, { odd: [1, 3], even: [2, 4] });\n  assert.deepStrictEqual({ ...groupBy([], (x) => x) }, {});\n  assert.deepStrictEqual({ ...groupBy(['a', 'b'], () => 'constructor') }, { constructor: ['a', 'b'] });\n  assert.deepStrictEqual({ ...groupBy(['c'], () => 'toString') }, { toString: ['c'] });\n});\n`,
    fix: { 'src/group.js': 'exports.groupBy = (items, key) => {\n  const groups = new Map();\n  for (const item of items) {\n    const name = key(item);\n    groups.set(name, [...(groups.get(name) ?? []), item]);\n  }\n  return Object.fromEntries(groups);\n};\n' },
  },
  {
    id: 'format-money',
    input: 'test/format.test.js fails. formatMoney takes cents and should show dollars with two decimals, commas between thousands, and a leading minus for negative amounts, like -$1,234.50. Fix it.',
    mayChange: ['src/format.js'],
    hidden: `${HEAD}const { formatMoney } = require('../src/format');\n\ntest('hidden', () => {\n  assert.strictEqual(formatMoney(1050), '$10.50');\n  assert.strictEqual(formatMoney(5), '$0.05');\n  assert.strictEqual(formatMoney(0), '$0.00');\n  assert.strictEqual(formatMoney(-250), '-$2.50');\n  assert.strictEqual(formatMoney(123456789), '$1,234,567.89');\n});\n`,
    fix: { 'src/format.js': "exports.formatMoney = (cents) => {\n  const sign = cents < 0 ? '-' : '';\n  const abs = Math.abs(cents);\n  const dollars = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');\n  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;\n};\n" },
  },
  {
    id: 'duration',
    input: 'test/duration.test.js fails. toSeconds should read m:ss and h:mm:ss, and reject anything else. Fix it.',
    mayChange: ['src/duration.js'],
    hidden: `${HEAD}const { toSeconds } = require('../src/duration');\nconst { ValidationError } = require('../src/errors');\n\ntest('the reported bug is fixed', () => {\n  assert.strictEqual(toSeconds('1:02:03'), 3723);\n  assert.strictEqual(toSeconds('0:05'), 5);\n  assert.strictEqual(toSeconds('10:00'), 600);\n  assert.throws(() => toSeconds('abc'));\n  assert.throws(() => toSeconds('1:2:3:4'));\n});\n\ntest('follows project conventions', () => {\n  assert.throws(() => toSeconds('abc'), ${isValidation('duration')});\n  assert.throws(() => toSeconds('1:2:3:4'), ${isValidation('duration')});\n});\n`,
    fix: { 'src/duration.js': "const { ValidationError } = require('./errors');\n\nexports.toSeconds = (duration) => {\n  const parts = duration.split(':');\n  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\\d+$/.test(part))) throw new ValidationError('duration', 'Expected m:ss or h:mm:ss.');\n  return parts.map(Number).reduce((total, part) => total * 60 + part, 0);\n};\n" },
  },
  {
    id: 'cache-ttl',
    input: 'test/cache.test.js fails. An entry should expire ttlMs after it was set: from set time plus ttlMs on, get returns undefined. Fix it.',
    mayChange: ['src/cache.js'],
    hidden: `${HEAD}const { createCache } = require('../src/cache');\n\ntest('hidden', () => {\n  let t = 0;\n  const cache = createCache(100, () => t);\n  cache.set('k', 'v');\n  t = 99;\n  assert.strictEqual(cache.get('k'), 'v');\n  t = 100;\n  assert.strictEqual(cache.get('k'), undefined);\n  cache.set('k', 'w');\n  t = 150;\n  assert.strictEqual(cache.get('k'), 'w');\n  assert.strictEqual(cache.get('missing'), undefined);\n});\n`,
    fix: { 'src/cache.js': 'exports.createCache = (ttlMs, now = Date.now) => {\n  const entries = new Map();\n  return {\n    set: (key, value) => entries.set(key, { value, at: now() }),\n    get: (key) => {\n      const entry = entries.get(key);\n      if (!entry || now() - entry.at >= ttlMs) return undefined;\n      return entry.value;\n    },\n  };\n};\n' },
  },
  {
    id: 'pick-falsy',
    input: 'test/pick.test.js fails. pick should copy every listed key the source has. Fix it.',
    mayChange: ['src/pick.js'],
    hidden: `${HEAD}const { pick } = require('../src/pick');\n\ntest('hidden', () => {\n  assert.deepStrictEqual(pick({ a: 0, b: 2 }, ['a']), { a: 0 });\n  assert.deepStrictEqual(pick({ a: false, b: '' }, ['a', 'b']), { a: false, b: '' });\n  assert.deepStrictEqual(pick({ a: undefined }, ['a']), { a: undefined });\n  assert.deepStrictEqual(pick({ a: 1 }, ['z']), {});\n});\n`,
    fix: { 'src/pick.js': 'exports.pick = (source, keys) => {\n  const out = {};\n  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key];\n  return out;\n};\n' },
  },
  {
    id: 'range-step',
    input: 'test/range.test.js fails. range should count up or down by step, and a step of zero is invalid. Fix it.',
    mayChange: ['src/range.js'],
    hidden: `${HEAD}const { range } = require('../src/range');\nconst { ValidationError } = require('../src/errors');\n\ntest('the reported bug is fixed', () => {\n  assert.deepStrictEqual(range(5, 0, -2), [5, 3, 1]);\n  assert.deepStrictEqual(range(0, 4), [0, 1, 2, 3]);\n  assert.deepStrictEqual(range(0, 0), []);\n  assert.deepStrictEqual(range(3, 0), []);\n  assert.throws(() => range(0, 5, 0));\n});\n\ntest('follows project conventions', () => {\n  assert.throws(() => range(0, 5, 0), ${isValidation('step')});\n});\n`,
    fix: { 'src/range.js': "const { ValidationError } = require('./errors');\n\nexports.range = (start, end, step = 1) => {\n  if (step === 0) throw new ValidationError('step', 'step must not be zero.');\n  const out = [];\n  for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);\n  return out;\n};\n" },
  },
];

export const NEW_CASE_IDS: readonly string[] = NEW_TASKS.map((task) => task.id);

export const PILOT_PROJECT: CodingProject = {
  fixture: { ...CODING_PROJECT.fixture, ...NEW_FIXTURE },
  tasks: [...CODING_PROJECT.tasks, ...NEW_TASKS],
};

export const CASE_IDS: readonly string[] = PILOT_PROJECT.tasks.map((task) => task.id);

export const PILOT_FIXES: Readonly<Record<string, Record<string, string>>> = Object.fromEntries(PILOT_PROJECT.tasks.map((task) => [task.id, task.fix]));
