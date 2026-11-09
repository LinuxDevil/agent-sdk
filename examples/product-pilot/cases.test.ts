import { describe, expect, it } from 'vitest';
import { CODING_PROJECT, codingAgent, runProjectTests } from '../heal-benchmark/codingAgent';
import { CASE_IDS, NEW_CASE_IDS, PILOT_FIXES, PILOT_PROJECT } from './cases';

const caseOf = (id: string, seed: Record<string, string> = {}) => {
  const task = codingAgent(seed, PILOT_PROJECT).tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`No case ${id}`);
  return task;
};

const visibleTest = (id: string): string => {
  const match = /test\/[a-z]+\.test\.js/.exec(caseOf(id).input);
  if (!match) throw new Error(`No visible test named in ${id}`);
  return match[0];
};

describe('pilot cases', () => {
  it('reuses every heal-benchmark coding case unchanged and adds new ones to reach 20-30', () => {
    const existing = CODING_PROJECT.tasks.map((task) => task.id);
    expect(CASE_IDS.slice(0, existing.length)).toEqual(existing);
    expect(PILOT_PROJECT.tasks.slice(0, existing.length)).toEqual(CODING_PROJECT.tasks);
    expect(CASE_IDS.length).toBeGreaterThanOrEqual(20);
    expect(CASE_IDS.length).toBeLessThanOrEqual(30);
    expect(new Set(CASE_IDS).size).toBe(CASE_IDS.length);
    expect(NEW_CASE_IDS.every((id) => !existing.includes(id))).toBe(true);
  });

  it('keeps the heal-benchmark fixture files as they are', () => {
    for (const [name, content] of Object.entries(CODING_PROJECT.fixture)) expect(PILOT_PROJECT.fixture[name]).toBe(content);
  });

  it('fails every case on the untouched project, whatever the answer says', () => {
    for (const id of CASE_IDS) expect(caseOf(id).check('Fixed, all tests pass.'), id).toBe(false);
  });

  it('passes every case once its reference fix is written, and gives the same answer twice', () => {
    for (const [id, fix] of Object.entries(PILOT_FIXES)) {
      expect(caseOf(id, fix).check(''), id).toBe(true);
      expect(caseOf(id, fix).failure?.(), id).toBeUndefined();
    }
  });

  it('has a visible test that fails before each new fix and passes after it', () => {
    for (const id of NEW_CASE_IDS) {
      const file = visibleTest(id);
      expect(runProjectTests(codingAgent({}, PILOT_PROJECT).files, file).exitCode, id).not.toBe(0);
      expect(runProjectTests(codingAgent(PILOT_FIXES[id], PILOT_PROJECT).files, file).exitCode, id).toBe(0);
    }
  });

  it('fails fixes that pass the visible test but break a convention, another caller or a hidden edge case', () => {
    const shallow: [string, Record<string, string>, string][] = [
      ['order-totals', { 'src/orders.js': 'exports.withTotals = (orders) => {\n  for (const order of orders) order.total = order.price * order.qty;\n  return orders;\n};\n' }, 'follows project conventions'],
      ['top-scores', { 'src/rank.js': 'exports.topScores = (scores, n) => scores.sort((a, b) => b - a).slice(0, n);\n' }, 'follows project conventions'],
      ['parse-age', { 'src/age.js': "exports.parseAge = (age) => {\n  if (!/^\\d+$/.test(age)) throw new Error('bad');\n  return Number(age);\n};\n" }, 'follows project conventions'],
      ['card-title', { 'src/text.js': "exports.truncate = (text, n) => (text.length > n ? text.slice(0, n - 3) + '...' : text);\n" }, 'other callers keep their behaviour'],
      ['merge-config', { 'src/config.js': 'const merge = (base, override) => {\n  for (const [k, v] of Object.entries(override)) base[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] ? merge(base[k], v) : v;\n  return base;\n};\nexports.mergeConfig = merge;\n' }, 'follows project conventions'],
      ['percent-root-cause', { 'src/share.js': 'exports.shareLine = (name, part, whole) => `${name}: ${Math.round((part / whole) * 100)}%`;\n' }, 'changed only the files this task allows'],
      ['pick-falsy', { 'src/pick.js': 'exports.pick = (source, keys) => {\n  const out = {};\n  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];\n  return out;\n};\n' }, 'hidden'],
      ['cache-ttl', { 'src/cache.js': 'exports.createCache = (ttlMs, now = Date.now) => {\n  const entries = new Map();\n  return {\n    set: (key, value) => entries.set(key, { value, at: now() }),\n    get: (key) => {\n      const entry = entries.get(key);\n      return entry && now() - entry.at <= ttlMs ? entry.value : undefined;\n    },\n  };\n};\n' }, 'hidden'],
      ['clamp-range', { 'src/clamp.js': 'exports.clamp = (n) => n;\n' }, 'hidden'],
      ['group-by', { 'src/group.js': 'exports.groupBy = (items, key) =>\n  items.reduce((groups, item) => {\n    (groups[key(item)] = groups[key(item)] || []).push(item);\n    return groups;\n  }, {});\n' }, 'hidden'],
    ];
    for (const [id, seed, failure] of shallow) {
      expect(runProjectTests(codingAgent(seed, PILOT_PROJECT).files, visibleTest(id)).exitCode, id).toBe(0);
      expect(caseOf(id, seed).failure?.(), id).toBe(failure);
    }
  });

  it('accepts other correct fixes, not only the reference one', () => {
    const alternatives: [string, Record<string, string>][] = [
      ['group-by', { 'src/group.js': 'exports.groupBy = (items, key) =>\n  items.reduce((groups, item) => {\n    (groups[key(item)] ??= []).push(item);\n    return groups;\n  }, Object.create(null));\n' }],
      ['pick-falsy', { 'src/pick.js': 'exports.pick = (source, keys) => Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));\n' }],
      ['card-title', { 'src/text.js': "exports.truncate = (text, n, keep = n) => (text.length > n ? text.slice(0, keep) + '...' : text);\n", 'src/title.js': "const { truncate } = require('./text');\n\nexports.cardTitle = (text) => truncate(text, 10, 7);\n" }],
      ['top-scores', { 'src/rank.js': 'exports.topScores = (scores, n) => scores.slice().sort((a, b) => b - a).slice(0, n);\n' }],
    ];
    for (const [id, seed] of alternatives) expect(caseOf(id, seed).failure?.(), id).toBeUndefined();
  });

  it('fails a run that edits a test or a file the case does not allow', () => {
    expect(caseOf('clamp-range', { ...PILOT_FIXES['clamp-range'], 'test/clamp.test.js': "require('node:test')('x', () => {});\n" }).check('')).toBe(false);
    expect(caseOf('clamp-range', { ...PILOT_FIXES['clamp-range'], 'src/new.js': 'exports.x = 1;\n' }).check('')).toBe(false);
  });

  it('uses only synthetic fixtures: no imports outside the project and no absolute paths', () => {
    for (const [name, content] of Object.entries(PILOT_PROJECT.fixture)) {
      const imports = [...content.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
      expect(imports.every((spec) => spec.startsWith('node:') || spec.startsWith('.')), name).toBe(true);
      expect(content, name).not.toMatch(/\/Users\/|\/home\/|https?:\/\//);
    }
  });
});
