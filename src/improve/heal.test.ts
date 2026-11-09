import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestEvent } from '../observe/envelope';
import { ingestBatch, openDb } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { mockModel, type MockRequest, type MockTurn } from '../testing';
import { readAudit } from './audit';
import { canaryReplay } from './canary';
import { guardCorpus } from './corpusGuard';
import { readCorpus } from './corpus';
import { newCycleId, readCycles, writeCycle } from './cycles';
import { healOnce, type HealOptions } from './heal';
import { improveAgent } from './improve';
import { listPending, rejectPending } from './pending';
import { currentRevision } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import type { Harness } from './types';

vi.mock('./canary', async (original) => {
  const actual = await original<typeof import('./canary')>();
  return { ...actual, canaryReplay: vi.fn(actual.canaryReplay) };
});

vi.mock('./improve', async (original) => {
  const actual = await original<typeof import('./improve')>();
  return { ...actual, improveAgent: vi.fn(actual.improveAgent) };
});

vi.mock('./corpusGuard', async (original) => {
  const actual = await original<typeof import('./corpusGuard')>();
  return { ...actual, guardCorpus: vi.fn(actual.guardCorpus) };
});

const BASE = 'You answer refund questions.';
const FIX = 'You answer refund questions. If a document is forbidden, say so and stop.';
const WRONG = 'You answer refund questions. Always be brief.';
const T0 = Date.now() - 60_000;

let root: string;
let dir: string;
let db: SqlDatabase;

const systemOf = (request: MockRequest): string => String(request.messages.find((message) => message.role === 'system')?.content ?? '');
const isReflection = (request: MockRequest): boolean => systemOf(request).includes('finished attempt to improve');
const isComposer = (request: MockRequest): boolean => systemOf(request).includes('You are the composer.');

function editorWriting(instructions: string, hooks: { compose?: () => void; reflect?: () => never } = {}): MockTurn {
  return (request) => {
    if (isReflection(request)) {
      hooks.reflect?.();
      return 'NO_ENTRY';
    }
    if (request.messages.at(-1)?.role === 'tool') return '<notes>Traced to a failed run.</notes>';
    if (isComposer(request)) hooks.compose?.();
    return { toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content: instructions } }] };
  };
}

const editor = (instructions = FIX, hooks: Parameters<typeof editorWriting>[1] = {}) => ({ provider: mockModel([editorWriting(instructions, hooks)], { onExhausted: 'repeat-last' }) });

const answers = (harness: Harness): string => (harness.instructions.includes('forbidden') ? 'ok, that is forbidden' : 'here is the doc');

const runCase: HealOptions['runCase'] = async (harness, input) => ({ answer: input.includes('refund window') ? 'five days' : answers(harness), transcript: `user: ${input}\nassistant: ${answers(harness)}`, tokens: 10, ended: 'stop' });

const check: HealOptions['check'] = (input, answer) => input.includes('refund window') || answer.startsWith('ok');

function root_(trace: string, revision: string, input: string): IngestEvent {
  return {
    type: 'observation',
    data: { obs_id: `r-${trace}`, trace_id: trace, agent_id: 'support', kind: 'span', name: 'invoke_agent support', start: T0, end: T0 + 9, status: 'ok', input, output: 'done', attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.harness.revision': revision } },
  };
}

function failed(trace: string, revision = currentRevision(dir)): IngestEvent[] {
  return [
    root_(trace, revision, JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'can I read the secret doc?' }] }])),
    {
      type: 'observation',
      data: {
        obs_id: `t-${trace}`,
        trace_id: trace,
        parent_obs_id: `r-${trace}`,
        agent_id: 'support',
        kind: 'tool',
        name: 'execute_tool lookup',
        start: T0,
        end: T0 + 5,
        status: 'error',
        attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', error: 'HTTP 403 Forbidden' },
      },
    },
  ];
}

const seedFailures = (traces = ['t1', 't2', 't3'], revision?: string) => ingestBatch(db, traces.flatMap((trace) => failed(trace, revision)));

function settings(over: Partial<ImproveSettings> = {}): ImproveSettings {
  const loaded = loadImproveSettings(dir, {}, {});
  return { ...loaded, library: { enabled: false }, ...over };
}

const heal = (over: Partial<HealOptions> = {}) => healOnce({ dir, db, check, runCase, editor: editor(), settings: settings(), ...over });

const instructions = () => readFileSync(path.join(dir, 'instructions.md'), 'utf8').trim();
const actions = () => readAudit(dir).map((entry) => entry.action);

function tree(base: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[path.relative(base, path.join(entry.parentPath, entry.name))] = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return files;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lousho-heal-'));
  dir = path.join(root, 'support');
  mkdirSync(path.join(dir, 'skills', 'refunds'), { recursive: true });
  writeFileSync(path.join(dir, 'instructions.md'), `${BASE}\n`);
  writeFileSync(path.join(dir, 'skills', 'refunds', 'SKILL.md'), '---\nname: refunds\ndescription: How refunds work\n---\nRefunds take 5 days.\n');
  db = openDb(path.join(root, 'observe.db'));
  ingestBatch(db, [root_('p1', currentRevision(dir), '"what is the refund window?"')]);
});

afterEach(() => {
  db.close();
  vi.mocked(canaryReplay).mockClear();
  vi.mocked(guardCorpus).mockClear();
  vi.mocked(improveAgent).mockClear();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('healOnce', () => {
  it('auto: a true fix is applied, guarded and audited', async () => {
    seedFailures();
    const from = currentRevision(dir);
    const cycle = await heal({ protect: ['p1'] });
    expect(cycle).toMatchObject({ outcome: 'applied', trigger: 'failures', approval: 'auto', from, to: currentRevision(dir) });
    expect(instructions()).toBe(FIX);
    expect(cycle.canary?.passed).toBe(true);
    expect(cycle.guard?.passed).toBe(true);
    expect(readCorpus(dir).map((item) => item.id)).toEqual(['pass:p1']);
    expect(actions()).toEqual(['canary-end', 'apply', 'guard-pass']);
    expect(readAudit(dir).every((entry) => entry.cycle === undefined || entry.cycle === cycle.id)).toBe(true);
    expect(readCycles(dir)).toEqual([expect.objectContaining({ id: cycle.id, outcome: 'applied', tokens: cycle.tokens })]);
    expect(cycle.tokens).toBeGreaterThan(0);
  });

  it('manual: the same fix becomes a pending proposal and nothing is written', async () => {
    seedFailures();
    const before = instructions();
    const cycle = await heal({ settings: settings({ approval: 'manual', trigger: { minNewFailures: 3, requireRecurring: false } }) });
    expect(cycle.outcome).toBe('pending');
    expect(instructions()).toBe(before);
    expect(listPending(dir).map((item) => item.id)).toEqual([cycle.pending]);
    expect(actions()).toEqual(['canary-end', 'propose']);
  });

  it('a canary failure applies nothing', async () => {
    seedFailures();
    vi.mocked(canaryReplay).mockResolvedValueOnce({ passed: false, cases: [], reason: 'A training case fell below 5 in 6 fresh runs (x).', tokens: 7 });
    const cycle = await heal();
    expect(cycle.outcome).toBe('canary-failed');
    expect(instructions()).toBe(BASE);
    expect(actions()).toEqual(['canary-end']);
  });

  it('runs the canary on fresh repeats above the gate, with the training and corpus cases', async () => {
    seedFailures();
    await heal({ protect: ['p1'] });
    expect(vi.mocked(canaryReplay).mock.calls[0]?.[0]).toMatchObject({ firstRepeat: 100, runs: 6, protected: ['pass:p1'], training: expect.arrayContaining([expect.stringMatching(/:t[123]$/)]) });
  });

  it('a guard regression rolls back in the same cycle and starts a cooldown', async () => {
    seedFailures();
    const regressing: HealOptions['runCase'] = async (harness, input) => {
      const run = await runCase(harness, input);
      const applied = readAudit(dir).some((entry) => entry.action === 'apply');
      return applied && input.includes('refund window') && harness.instructions.includes('forbidden') ? { ...run, answer: 'no idea' } : run;
    };
    const checkAnswer: HealOptions['check'] = (input, answer) => (input.includes('refund window') ? answer === 'five days' : answer.startsWith('ok'));
    const from = currentRevision(dir);
    const cycle = await heal({ protect: ['p1'], runCase: regressing, check: checkAnswer });
    expect(cycle).toMatchObject({ outcome: 'guard-rolled-back', rolledBackTo: from });
    expect(instructions()).toBe(BASE);
    expect(actions()).toEqual(['canary-end', 'apply', 'guard-fail', 'rollback']);
    seedFailures(['t4', 't5', 't6']);
    expect((await heal()).outcome).toBe('cooldown');
  });

  it('stale base is refused', async () => {
    seedFailures();
    const cycle = await heal({ editor: editor(FIX, { compose: () => appendFileSync(path.join(dir, 'instructions.md'), 'A person edited this.\n') }) });
    expect(cycle.outcome).toBe('stale');
    expect(instructions()).toContain('A person edited this.');
    expect(actions()).toEqual(['canary-end', 'stale']);
  });

  it('failures from another revision are ignored', async () => {
    seedFailures(['t1', 't2', 't3'], 'f'.repeat(64));
    const cycle = await heal();
    expect(cycle.outcome).toBe('idle');
    expect(instructions()).toBe(BASE);
    expect(readCycles(dir)).toEqual([]);
  });

  it('is idle below minNewFailures, and counts only failures since the last cycle', async () => {
    seedFailures(['t1', 't2']);
    expect((await heal()).outcome).toBe('idle');
    expect((await heal({ trigger: 'manual' })).outcome).toBe('applied');
  });

  it('auto mode needs a failure that recurs, unless a score regression started the cycle', async () => {
    seedFailures(['t1']);
    expect((await heal({ trigger: 'manual' })).outcome).toBe('idle');
    expect((await heal({ trigger: 'score' })).outcome).toBe('applied');
  });

  it('the stop file, LOUSHO_IMPROVE=off and enabled false pause it', async () => {
    seedFailures();
    vi.stubEnv('LOUSHO_IMPROVE', 'off');
    expect((await heal()).outcome).toBe('paused');
    vi.unstubAllEnvs();
    expect((await heal({ settings: settings({ enabled: false }) })).outcome).toBe('paused');
    mkdirSync(path.join(dir, '.lousho'), { recursive: true });
    writeFileSync(path.join(dir, '.lousho', 'improve.stop'), '');
    expect((await heal()).outcome).toBe('paused');
    expect(instructions()).toBe(BASE);
  });

  it('a pause that starts mid-cycle stops it before the write', async () => {
    seedFailures();
    const pause = () => {
      mkdirSync(path.join(dir, '.lousho'), { recursive: true });
      writeFileSync(path.join(dir, '.lousho', 'improve.stop'), '');
    };
    const cycle = await heal({ editor: editor(FIX, { compose: pause }) });
    expect(cycle.outcome).toBe('paused');
    expect(instructions()).toBe(BASE);
  });

  it('a second cycle on the same directory at once is busy', async () => {
    seedFailures();
    const [first, second] = await Promise.all([heal(), heal()]);
    expect([first.outcome, second.outcome].sort()).toEqual(['applied', 'busy']);
  });

  it('daily caps stop cycles, applies and tokens', async () => {
    seedFailures();
    expect((await heal({ settings: settings({ budget: { maxTokensPerDay: 2_000_000, maxCyclesPerDay: 4, maxAppliesPerDay: 1 } }) })).outcome).toBe('applied');
    seedFailures(['t4', 't5', 't6'], currentRevision(dir));
    const capped = await heal({ settings: settings({ budget: { maxTokensPerDay: 2_000_000, maxCyclesPerDay: 4, maxAppliesPerDay: 1 } }) });
    expect(capped).toMatchObject({ outcome: 'budget', reason: expect.stringMatching(/automatic apply/) });
    expect((await heal({ settings: settings({ budget: { maxTokensPerDay: 2_000_000, maxCyclesPerDay: 1, maxAppliesPerDay: 9 } }) })).outcome).toBe('budget');
    expect((await heal({ settings: settings({ budget: { maxTokensPerDay: 10, maxCyclesPerDay: 9, maxAppliesPerDay: 9 } }) })).outcome).toBe('budget');
  });

  it('a small token budget ends the cycle with budget-exceeded and applies nothing', async () => {
    seedFailures();
    const cycle = await heal({ maxTokens: 25 });
    expect(cycle.outcome).toBe('budget-exceeded');
    expect(instructions()).toBe(BASE);
    expect(readCycles(dir)[0]?.outcome).toBe('budget-exceeded');
  });

  it('an outage, every failure passing on replay, and an editor that changes nothing end without a write', async () => {
    seedFailures();
    const down: HealOptions['runCase'] = async () => {
      throw new Error('provider down');
    };
    const outage = await heal({ runCase: down });
    expect(outage).toMatchObject({ outcome: 'outage', errors: ['provider down'] });
    const healthy: HealOptions['runCase'] = async (harness, input) => ({ ...(await runCase(harness, input)), answer: 'ok' });
    expect((await heal({ trigger: 'manual', runCase: healthy })).outcome).toBe('no-failures');
    expect((await heal({ trigger: 'manual', editor: editor(BASE) })).outcome).toBe('keep-base');
    expect(instructions()).toBe(BASE);
    expect(actions()).toEqual([]);
  });

  it('a gate rejection is audited and reflected on, and a failed reflection is audited', async () => {
    seedFailures();
    const failing = () => {
      throw new Error('reflection model down');
    };
    const cycle = await heal({ editor: editor(WRONG, { reflect: failing }), settings: settings({ library: { enabled: true } }) });
    expect(cycle.outcome).toBe('keep-base');
    expect(actions()).toEqual(['reject', 'reflect-fail']);
    expect(readAudit(dir)[1]?.reason).toMatch(/reflection failed/);
  });

  it('a proposal rejected before is refused when it comes back', async () => {
    seedFailures();
    const manual = settings({ approval: 'manual', trigger: { minNewFailures: 3, requireRecurring: false } });
    const first = await heal({ settings: manual });
    await rejectPending(dir, first.pending as string, 'ana', 'not now');
    const again = await heal({ settings: manual, trigger: 'manual' });
    expect(again).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/rejected before/) });
  });

  it('an aborted cycle is left on disk as interrupted', async () => {
    seedFailures();
    const controller = new AbortController();
    const cycle = heal({ signal: controller.signal, editor: editor(FIX, { compose: () => controller.abort() }) });
    await expect(cycle).rejects.toThrow();
    expect(readCycles(dir)[0]?.outcome).toBe('interrupted');
    expect(instructions()).toBe(BASE);
  });

  it('undoes the apply when the guard throws, or cannot judge, without a library vote', async () => {
    seedFailures();
    vi.mocked(guardCorpus).mockRejectedValueOnce(new Error('disk full'));
    const thrown = await heal({ protect: ['p1'] });
    expect(thrown).toMatchObject({ outcome: 'guard-rolled-back', reason: expect.stringMatching(/could not run \(disk full\)/) });
    expect(instructions()).toBe(BASE);
    expect(actions()).toEqual(['canary-end', 'apply', 'rollback']);
  });

  it('a guard that cannot judge counts as a failure', async () => {
    seedFailures();
    vi.mocked(guardCorpus).mockResolvedValueOnce({ passed: false, cases: [], revision: 'x', runs: 0, tokens: 0, reason: 'Too few scored runs to judge pass:p1.' });
    const cycle = await heal({ protect: ['p1'] });
    expect(cycle).toMatchObject({ outcome: 'guard-rolled-back', reason: expect.stringMatching(/can't judge counts as a failure/) });
    expect(instructions()).toBe(BASE);
  });

  it('keeps the edit and says so when the rollback is refused', async () => {
    seedFailures();
    vi.mocked(guardCorpus).mockImplementationOnce(async () => {
      appendFileSync(path.join(dir, 'instructions.md'), 'A person edited this.\n');
      return { passed: false, cases: [{ caseId: 'pass:p1', role: 'holdout', base: { passed: 6, scored: 6 }, final: { passed: 0, scored: 6 }, reasons: [], class: 'regressed' }], revision: 'x', runs: 6, tokens: 0, reason: 'Corpus cases regressed.' };
    });
    const cycle = await heal({ protect: ['p1'] });
    expect(cycle).toMatchObject({ outcome: 'applied', reason: expect.stringMatching(/was refused/) });
    expect(instructions()).toContain('A person edited this.');
  });

  it('guards an apply whose cycle stopped before its guard, at the start of the next cycle', async () => {
    seedFailures();
    const first = await heal({ protect: ['p1'] });
    const { guard: _guard, ...unguarded } = first;
    writeCycle(dir, { ...unguarded, outcome: 'interrupted' });
    const regressing: HealOptions['runCase'] = async (harness, input) => {
      const run = await runCase(harness, input);
      return input.includes('refund window') && harness.instructions.includes('forbidden') ? { ...run, answer: 'no idea' } : run;
    };
    const checkAnswer: HealOptions['check'] = (input, answer) => (input.includes('refund window') ? answer === 'five days' : answer.startsWith('ok'));
    const next = await heal({ runCase: regressing, check: checkAnswer });
    expect(next.outcome).toBe('cooldown');
    expect(readCycles(dir).find((item) => item.id === first.id)).toMatchObject({ outcome: 'guard-rolled-back', reason: expect.stringMatching(/^Guarded after an interruption/) });
    expect(instructions()).toBe(BASE);
  });

  it('stops before the editors when the kill switch flips during admission', async () => {
    seedFailures();
    const pausing: HealOptions['runCase'] = async (harness, input) => {
      mkdirSync(path.join(dir, '.lousho'), { recursive: true });
      writeFileSync(path.join(dir, '.lousho', 'improve.stop'), '');
      return runCase(harness, input);
    };
    const cycle = await heal({ protect: ['p1'], runCase: pausing });
    expect(cycle).toMatchObject({ outcome: 'paused', reason: expect.stringMatching(/before the editors ran/) });
    expect(cycle.result).toBeUndefined();
  });

  it('queues instead of applying when improve.json switches to manual mid-cycle', async () => {
    seedFailures();
    const cycle = await heal({ editor: editor(FIX, { compose: () => writeFileSync(path.join(dir, 'improve.json'), '{ "approval": "manual" }') }) });
    expect(cycle).toMatchObject({ outcome: 'pending', approval: 'manual' });
    expect(instructions()).toBe(BASE);
  });

  it('applies nothing when the budget left cannot pay for the corpus guard', async () => {
    seedFailures();
    vi.mocked(canaryReplay).mockResolvedValueOnce({ passed: true, cases: [{ caseId: 'x', role: 'training', base: { passed: 0, scored: 0 }, final: { passed: 6, scored: 6 }, reasons: [] }], reason: 'Held.', tokens: 1_000_000 });
    const cycle = await heal({ protect: ['p1'], maxTokens: 100_000 });
    expect(cycle).toMatchObject({ outcome: 'budget-exceeded', reason: expect.stringMatching(/corpus guard/) });
    expect(instructions()).toBe(BASE);
  });

  it('passes the editors settings to improveAgent, with the defaults unchanged', async () => {
    seedFailures();
    await heal();
    expect(vi.mocked(improveAgent).mock.calls[0]?.[0]).toMatchObject({ proposers: 1, mode: 'agg', select: false, parallelEditors: true });
    seedFailures(['t4', 't5', 't6'], currentRevision(dir));
    vi.mocked(improveAgent).mockClear();
    await heal({ trigger: 'manual', settings: settings({ approval: 'manual', editors: { proposers: 2, mode: 'seq', select: true, parallel: false } }) });
    expect(vi.mocked(improveAgent).mock.calls[0]?.[0]).toMatchObject({ proposers: 2, mode: 'seq', select: true, parallelEditors: false });
  });

  it('with k proposers, stops before the editors when the last cycle scaled by k does not fit the budget left', async () => {
    seedFailures();
    const yesterday = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const stage = (label: 'invariant' | 'domain' | 'compose') => ({ label, status: 'edited' as const, notes: '', tokens: 1000 });
    writeCycle(dir, {
      id: newCycleId(yesterday),
      trigger: 'failures',
      approval: 'auto',
      outcome: 'keep-base',
      reason: 'Kept.',
      startedAt: new Date(yesterday).toISOString(),
      tokens: 60_000,
      result: { outcome: 'keep-base', reason: 'Kept.', base: { runs: 3, excluded: 0, passRate: 0, noise: 0, tokensPerRun: 10 }, stages: [stage('invariant'), stage('domain'), stage('compose')], spend: { tokens: 40_000 } },
      canary: { passed: true, cases: [], reason: 'Held.', tokens: 5_000 },
    });
    const wide = await heal({ maxTokens: 100_000, settings: settings({ editors: { proposers: 3, mode: 'agg', select: false, parallel: true } }) });
    expect(wide).toMatchObject({ outcome: 'budget-exceeded', reason: expect.stringMatching(/3 proposers .*about 125000 tokens.*40000 with 1/) });
    expect(improveAgent).not.toHaveBeenCalled();
    expect(instructions()).toBe(BASE);
    expect((await heal({ maxTokens: 100_000, trigger: 'manual' })).outcome).toBe('applied');
  });

  it('never writes outside instructions.md, skills/*/SKILL.md and .lousho/', async () => {
    seedFailures();
    const before = tree(root);
    await heal({ protect: ['p1'], settings: settings({ library: { enabled: true } }) });
    const changed = Object.keys(tree(root)).filter((file) => tree(root)[file] !== before[file]);
    const allowed = /^support\/(instructions\.md|skills\/[^/]+\/SKILL\.md|\.lousho\/.*)$|^observe\.db/;
    expect(changed.filter((file) => !allowed.test(file))).toEqual([]);
  });
});
