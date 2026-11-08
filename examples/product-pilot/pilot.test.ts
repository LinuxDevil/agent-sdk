import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mockModel } from 'lousho/testing';
import { codingAgent } from '../heal-benchmark/codingAgent';
import { houseRules, LEAD_TOOLS, MAX_STEPS, PAGE_TOOLS, parseArms, PRODUCT_DIR } from './arms';
import { CASE_IDS, PILOT_FIXES, PILOT_PROJECT } from './cases';
import { doneKeys, parseRows, planRuns, rowKey, runPilot, type PilotRow } from './pilot';

const FIX = PILOT_FIXES['page-count']['src/pages.js'];
const NOW = () => new Date('2026-11-08T00:00:00.000Z');
const base = { cases: ['page-count'], repeats: 1, model: 'mock', gapMs: 0, maxTokens: 300_000, now: NOW };

describe('planRuns', () => {
  it('runs every arm on every case and repeat, with both arms of a case back to back', () => {
    const plan = planRuns(['flat', 'product'], ['a', 'b'], 3);
    expect(plan).toHaveLength(12);
    for (let i = 0; i < plan.length; i += 2) {
      expect(plan[i].caseId).toBe(plan[i + 1].caseId);
      expect(plan[i].repeat).toBe(plan[i + 1].repeat);
      expect(new Set([plan[i].arm, plan[i + 1].arm])).toEqual(new Set(['flat', 'product']));
    }
  });

  it('alternates which arm goes first, so neither always runs first', () => {
    const firsts = planRuns(['flat', 'product'], CASE_IDS, 3).filter((_, index) => index % 2 === 0).map((item) => item.arm);
    expect(firsts.filter((arm) => arm === 'flat').length).toBe(firsts.filter((arm) => arm === 'product').length);
  });
});

describe('resume', () => {
  it('skips runs already scored, and runs excluded ones again', () => {
    const scored: PilotRow = { arm: 'flat', case: 'page-count', repeat: 0, passed: false, tokens: 1, costUsd: null, modelCalls: 1, toolRuns: 0, ended: 'stop', model: 'mock', date: '' };
    const excluded: PilotRow = { ...scored, arm: 'product', passed: null };
    expect([...doneKeys([scored, excluded])]).toEqual([rowKey(scored)]);
    expect(parseRows(`${JSON.stringify(scored)}\n\n${JSON.stringify(excluded)}\n`)).toEqual([scored, excluded]);
  });

  it('runs nothing that the cache already holds', async () => {
    const done = new Set([rowKey({ model: 'mock', arm: 'flat', case: 'page-count', repeat: 0 })]);
    const rows = await runPilot({ ...base, arms: ['flat'], done, provider: () => mockModel(['x']) });
    expect(rows).toEqual([]);
  });
});

describe('arms', () => {
  it('gives the product the same tools as the flat agent in total, and only the fix page can write', () => {
    const flat = codingAgent({}, PILOT_PROJECT).tools.map((tool) => tool.name).sort();
    expect([...new Set([...LEAD_TOOLS, ...Object.values(PAGE_TOOLS).flat()])].sort()).toEqual(flat);
    const writers = Object.entries(PAGE_TOOLS).filter(([, names]) => names.includes('write_file') || names.includes('edit_file'));
    expect(writers.map(([page]) => page)).toEqual(['fix']);
    expect(LEAD_TOOLS).not.toContain('write_file');
  });

  it('has a page directory for each page, each with its own skill and the same house rules copied in', () => {
    const pages = readdirSync(path.join(PRODUCT_DIR, 'subagents')).sort();
    expect(pages).toEqual(Object.keys(PAGE_TOOLS).sort());
    for (const page of pages) {
      expect(houseRules(page)).toBe(houseRules());
      expect(readdirSync(path.join(PRODUCT_DIR, 'subagents', page, 'skills'))).toHaveLength(1);
    }
    expect(readFileSync(path.join(PRODUCT_DIR, 'instructions.md'), 'utf8')).not.toContain('## House rules');
  });

  it('gives the lead and every page the same step limit as the flat agent', () => {
    const steps = (dir: string) => (JSON.parse(readFileSync(path.join(dir, 'agent.json'), 'utf8')) as { maxSteps: number }).maxSteps;
    expect(steps(PRODUCT_DIR)).toBe(MAX_STEPS);
    for (const page of Object.keys(PAGE_TOOLS)) expect(steps(path.join(PRODUCT_DIR, 'subagents', page))).toBe(MAX_STEPS);
  });

  it('parses --arms', () => {
    expect(parseArms('flat, product')).toEqual(['flat', 'product']);
    expect(() => parseArms('flat,router')).toThrow(/router/);
  });
});

describe('runPilot with a mock model', () => {
  it('scores the flat agent by the hidden tests after it fixes the bug', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'read_file', args: { path: 'src/pages.js' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'src/pages.js', content: FIX } }] },
      'Fixed pageCount.',
    ]);
    const rows: PilotRow[] = [];
    await runPilot({ ...base, arms: ['flat'], provider: () => provider, onRow: (row) => rows.push(row) });
    expect(rows).toEqual([expect.objectContaining({ arm: 'flat', case: 'page-count', repeat: 0, passed: true, ended: 'stop', toolRuns: 2, model: 'mock', date: '2026-11-08T00:00:00.000Z' })]);
    expect(rows[0].modelCalls).toBe(3);
    expect(rows[0].tokens).toBeGreaterThan(0);
    expect(rows[0].failure).toBeUndefined();
  });

  it('runs the product: the lead delegates to the fix page, which edits the shared project', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'fix', prompt: 'pageCount rounds down. Use Math.ceil in src/pages.js.', description: 'fix page count' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'src/pages.js', content: FIX } }] },
      'Changed src/pages.js. Tests pass.',
      'Fixed.',
    ]);
    const [row] = await runPilot({ ...base, arms: ['product'], provider: () => provider });
    expect(row).toMatchObject({ arm: 'product', passed: true, ended: 'stop', toolRuns: 2, modelCalls: 4 });
  });

  it('fails a run that does not fix the bug and names the failed check', async () => {
    const [row] = await runPilot({ ...base, arms: ['flat-plus'], provider: () => mockModel(['Done.']) });
    expect(row).toMatchObject({ arm: 'flat-plus', passed: false });
    expect(row.failure).toBeTruthy();
  });

  it('leaves a run out of the score when a page crashes, as a provider error in the flat arm is', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'fix', prompt: 'Fix pageCount.' } }] },
      { error: new Error('provider unavailable') },
      'The fix page failed.',
    ]);
    const [row] = await runPilot({ ...base, arms: ['product'], provider: () => provider });
    expect(row).toMatchObject({ arm: 'product', passed: null, ended: 'page-error' });
    expect(row.failure).toMatch(/Sub-agent 'fix' failed: .*provider unavailable/);
    const [flat] = await runPilot({ ...base, arms: ['flat'], provider: () => mockModel([{ error: new Error('provider unavailable') }]) });
    expect(flat.passed).toBeNull();
  });

  it('refuses a page that tries a tool it was not given', async () => {
    const provider = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'review', prompt: 'Write the fix.' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'src/pages.js', content: FIX } }] },
      'I could not write.',
      'Not fixed.',
    ]);
    const [row] = await runPilot({ ...base, arms: ['product'], provider: () => provider });
    expect(row.passed).toBe(false);
  });
});
