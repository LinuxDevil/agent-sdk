import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestEvent } from '../observe/envelope';
import { ingestBatch, openDb } from '../observe/store';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { mockModel, type MockRequest } from '../testing';
import { appendAudit, readAudit } from './audit';
import { readCorpus } from './corpus';
import { readCycles, usageToday } from './cycles';
import { budgetLeft } from './watchSteps';
import { healOnce, type HealOptions } from './heal';
import { checkApplied } from './monitor';
import { currentRevision } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import { updateState } from './state';
import type { Harness } from './types';
import { isDefinedSchedule } from '../schedules/defineSchedule';
import { noticeEvent } from './notify';
import { improveSchedule, watchAgent, watchContext, watchTick, type WatchOptions } from './watch';

vi.mock('./heal', async (original) => {
  const actual = await original<typeof import('./heal')>();
  return { ...actual, healOnce: vi.fn(actual.healOnce) };
});

vi.mock('./monitor', async (original) => {
  const actual = await original<typeof import('./monitor')>();
  return { ...actual, checkApplied: vi.fn(actual.checkApplied) };
});

const BASE = 'You answer refund questions.';
const FIX = 'You answer refund questions. If a document is forbidden, say so and stop.';
const T0 = Date.now() - 60_000;

let root: string;
let dir: string;
let db: SqlDatabase;
let traces = 0;

const systemOf = (request: MockRequest): string => String(request.messages.find((message) => message.role === 'system')?.content ?? '');

const editor = () =>
  mockModel(
    [
      (request) => {
        if (systemOf(request).includes('finished attempt to improve')) return 'NO_ENTRY';
        if (request.messages.at(-1)?.role === 'tool') return '<notes>Traced to a failed run.</notes>';
        return { toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content: FIX } }] };
      },
    ],
    { onExhausted: 'repeat-last' }
  );

const answers = (harness: Harness): string => (harness.instructions.includes('forbidden') ? 'ok, that is forbidden' : 'here is the doc');
const runCase: HealOptions['runCase'] = async (harness, input) => ({ answer: input.includes('refund window') ? 'five days' : answers(harness), transcript: `assistant: ${answers(harness)}`, tokens: 10, ended: 'stop' });
const check: HealOptions['check'] = (input, answer) => input.includes('refund window') || answer.startsWith('ok');

function root_(trace: string, input: string, start = T0): IngestEvent {
  return {
    type: 'observation',
    data: { obs_id: `r-${trace}`, trace_id: trace, agent_id: 'support', kind: 'span', name: 'invoke_agent support', start, end: start + 9, status: 'ok', input, output: 'done', attrs: { 'gen_ai.operation.name': 'invoke_agent', 'lousho.harness.revision': currentRevision(dir) } },
  };
}

function seedFailures(count = 3): void {
  const events = Array.from({ length: count }, (): IngestEvent[] => {
    const trace = `t${traces++}`;
    const at = Date.now() + traces;
    return [
      root_(trace, '"can I read the secret doc?"', at),
      {
        type: 'observation',
        data: { obs_id: `x-${trace}`, trace_id: trace, parent_obs_id: `r-${trace}`, agent_id: 'support', kind: 'tool', name: 'execute_tool lookup', start: at, end: at + 5, status: 'error', attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup', error: 'HTTP 403 Forbidden' } },
      },
    ];
  }).flat();
  ingestBatch(db, events);
}

function settings(over: Partial<ImproveSettings> = {}): ImproveSettings {
  return { ...loadImproveSettings(dir, {}, {}), library: { enabled: false }, ...over };
}

const options = (over: Partial<WatchOptions> = {}): WatchOptions => ({ dir, db, check, runCase, editor: { provider: editor() }, settings: settings(), agent: 'support', log: () => undefined, ...over });

const tick = (over: Partial<WatchOptions> = {}, context = watchContext(options(over))) => watchTick(options(over), context);

const actions = () => readAudit(dir).map((entry) => entry.action);
const stop = () => {
  mkdirSync(path.join(dir, '.lousho'), { recursive: true });
  writeFileSync(path.join(dir, '.lousho', 'improve.stop'), 'maintenance\n');
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lousho-watch-'));
  dir = path.join(root, 'support');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'instructions.md'), `${BASE}\n`);
  db = openDb(path.join(root, 'observe.db'));
  ingestBatch(db, [root_('p1', '"what is the refund window?"')]);
});

afterEach(() => {
  db.close();
  vi.mocked(healOnce).mockClear();
  vi.mocked(checkApplied).mockClear();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('watchTick', () => {
  it('the stop file prevents any cycle and is audited once', async () => {
    seedFailures();
    stop();
    expect((await tick()).state).toBe('paused');
    expect((await tick()).state).toBe('paused');
    expect(healOnce).not.toHaveBeenCalled();
    expect(actions()).toEqual(['pause']);
    rmSync(path.join(dir, '.lousho', 'improve.stop'));
    const resumed = await tick();
    expect(resumed.cycle?.outcome).toBe('applied');
    expect(actions().slice(0, 2)).toEqual(['pause', 'resume']);
  });

  it('LOUSHO_IMPROVE=off and enabled false pause it too', async () => {
    vi.stubEnv('LOUSHO_IMPROVE', 'off');
    expect((await tick()).state).toBe('paused');
    vi.unstubAllEnvs();
    expect((await tick({ settings: settings({ enabled: false }) })).state).toBe('paused');
    expect(actions()).toEqual(['pause']);
  });

  it('the second watcher on the same dir does nothing', async () => {
    seedFailures();
    const first = await tick();
    expect(first.cycle?.outcome).toBe('applied');
    const second = await tick();
    expect(second).toMatchObject({ state: 'leased' });
    expect(healOnce).toHaveBeenCalledTimes(1);
  });

  it('maxAppliesPerDay 1 blocks a second apply the same day', async () => {
    const context = watchContext(options());
    seedFailures();
    expect((await watchTick(options(), context)).cycle?.outcome).toBe('applied');
    seedFailures();
    expect((await watchTick(options(), context)).cycle).toMatchObject({ outcome: 'budget', reason: expect.stringMatching(/automatic apply/) });
  });

  it('cooldown after rollback blocks cycles', async () => {
    seedFailures();
    await updateState(dir, { cooldownUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const result = await tick();
    expect(result.reason).toMatch(/cooldown/);
    expect(healOnce).not.toHaveBeenCalled();
  });

  it('the token budget passed to healOnce shrinks as spent', async () => {
    const context = watchContext(options());
    const manual = settings({ approval: 'manual', trigger: { minNewFailures: 3, requireRecurring: false } });
    seedFailures();
    await watchTick(options({ settings: manual }), context);
    seedFailures();
    await watchTick(options({ settings: manual }), context);
    const [first, second] = vi.mocked(healOnce).mock.calls.map(([call]) => call.maxTokens as number);
    const spent = readCycles(dir).find((cycle) => cycle.outcome !== 'interrupted')?.tokens ?? 0;
    expect(first).toBe(2_000_000);
    expect(spent).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
  });

  it('same signatures twice skip the second cycle', async () => {
    const context = watchContext(options());
    const manual = settings({ approval: 'manual', trigger: { minNewFailures: 3, requireRecurring: false } });
    seedFailures();
    expect((await watchTick(options({ settings: manual }), context)).cycle?.outcome).toBe('pending');
    expect((await watchTick(options({ settings: manual }), context)).state).toBe('deduped');
    expect(healOnce).toHaveBeenCalledTimes(1);
  });

  it('three outages in a row pause it with an audit entry', async () => {
    const context = watchContext(options());
    const down: HealOptions['runCase'] = async () => {
      throw new Error('provider down');
    };
    seedFailures();
    for (let i = 0; i < 3; i++) expect((await watchTick(options({ runCase: down, settings: settings({ trigger: { minNewFailures: 3, requireRecurring: true } }) }), context, 'manual')).cycle?.outcome).toBe('outage');
    expect(existsSync(path.join(dir, '.lousho', 'improve.stop'))).toBe(true);
    expect(actions()).toEqual(['pause']);
    expect((await watchTick(options({ runCase: down }), context)).state).toBe('paused');
    expect(actions()).toEqual(['pause']);
  });

  it('maxCyclesPerDay, the daily token cap and an audited rollback each stop the cycle', async () => {
    const context = watchContext(options());
    seedFailures();
    expect((await watchTick(options({ settings: settings({ budget: { maxTokensPerDay: 10, maxCyclesPerDay: 4, maxAppliesPerDay: 1 } }) }), context)).cycle).toMatchObject({ outcome: 'budget-exceeded' });
    expect((await watchTick(options({ settings: settings({ budget: { maxTokensPerDay: 2_000_000, maxCyclesPerDay: 1, maxAppliesPerDay: 1 } }) }), context, 'manual')).cycle).toMatchObject({ outcome: 'budget', reason: expect.stringMatching(/cycles have run/) });
    await appendAudit(dir, { actor: 'monitor', action: 'rollback', reason: 'Regressed.' });
    expect((await watchTick(options(), context, 'manual')).cycle).toMatchObject({ outcome: 'cooldown' });
  });

  it("counts the watcher's own guard runs toward the day's tokens", async () => {
    const context = watchContext(options());
    seedFailures();
    await watchTick(options({ protect: ['p1'] }), context);
    const before = usageToday(dir, Date.now()).tokens;
    const guarded = await watchTick(options(), context);
    expect(guarded.guard?.tokens).toBeGreaterThan(0);
    expect(usageToday(dir, Date.now()).tokens).toBe(before + (guarded.guard?.tokens ?? 0));
    expect(budgetLeft(dir, settings(), Date.now())).toBe(2_000_000 - usageToday(dir, Date.now()).tokens);
  });

  it('renews its lease while a long tick runs, so a second watcher stays out', async () => {
    seedFailures();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HealOptions['runCase'] = async (harness, input) => {
      await gate;
      return runCase(harness, input);
    };
    const short = { intervalMs: 30 };
    const first = watchTick(options({ ...short, runCase: slow }), watchContext(options(short)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await watchTick(options(short), watchContext(options(short)))).state).toBe('leased');
    release();
    expect((await first).cycle?.outcome).toBe('applied');
  });

  it('runs the corpus guard once guard.everyHours have passed', async () => {
    const context = watchContext(options());
    seedFailures();
    const first = await watchTick(options({ protect: ['p1'] }), context);
    expect(first.cycle?.outcome).toBe('applied');
    expect(first.guard).toBeUndefined();
    const second = await watchTick(options(), context);
    expect(second.guard).toMatchObject({ passed: true });
    expect((await watchTick(options(), context)).guard).toBeUndefined();
  });

  it('adds the cases a kept edit fixed to the corpus once the monitor keeps it, once', async () => {
    const context = watchContext(options());
    seedFailures();
    const applied = await watchTick(options(), context);
    expect(applied.cycle?.outcome).toBe('applied');
    const applySeq = readAudit(dir).find((entry) => entry.action === 'apply')?.seq as number;
    await updateState(dir, { monitor: { revision: currentRevision(dir), applySeq, at: new Date().toISOString(), verdict: { state: 'kept' } } });
    vi.mocked(checkApplied).mockResolvedValueOnce({ state: 'kept' }).mockResolvedValueOnce({ state: 'kept' });
    await watchTick(options(), context);
    const fixed = readCorpus(dir).filter((item) => item.origin === 'fixed');
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed.every((item) => item.revision === currentRevision(dir))).toBe(true);
    await watchTick(options(), context);
    expect(readCorpus(dir).filter((item) => item.origin === 'fixed')).toHaveLength(fixed.length);
    vi.mocked(checkApplied).mockResolvedValueOnce({ state: 'rolled-back' });
    await updateState(dir, { monitor: undefined });
    await watchTick(options(), context);
    expect(readCorpus(dir).filter((item) => item.origin === 'fixed')).toHaveLength(fixed.length);
  });
});

describe('notifications', () => {
  it('an apply posts one improve.applied', async () => {
    seedFailures();
    const post = vi.fn();
    const lines: string[] = [];
    const result = await tick({ alerter: { post }, log: (line) => lines.push(line) });
    expect(result.cycle?.outcome).toBe('applied');
    expect(post).toHaveBeenCalledTimes(1);
    const [[[event]]] = post.mock.calls;
    expect(event).toMatchObject({ type: 'improve.applied', agent_id: 'support', status: 'applied', details: { agent: 'support', dir, from: result.cycle?.from, to: result.cycle?.to, cycle: result.cycle?.id } });
    expect(lines).toEqual([expect.stringMatching(/^lousho improve: improve\.applied support: Applied/)]);
  });

  it('webhook failure never fails the cycle', async () => {
    seedFailures();
    const post = () => {
      throw new Error('webhook down');
    };
    const result = await tick({ alerter: { post }, log: () => {
      throw new Error('stderr closed');
    } });
    expect(result.cycle?.outcome).toBe('applied');
  });

  it('a pause and a pending proposal are posted, the pending one with its local card path', async () => {
    seedFailures();
    const post = vi.fn();
    const manual = settings({ approval: 'manual', trigger: { minNewFailures: 3, requireRecurring: false } });
    const queued = await tick({ alerter: { post }, settings: manual });
    stop();
    await tick({ alerter: { post } });
    await tick({ alerter: { post } });
    expect(post.mock.calls.map(([[event]]) => event.type)).toEqual(['improve.pending', 'improve.paused']);
    expect(post.mock.calls[0]?.[0][0].details.card).toBe(path.join(dir, '.lousho', 'proposals', `${queued.cycle?.pending}.json`));
  });

  it('no editor text reaches a webhook unsanitized', () => {
    const event = noticeEvent({ type: 'improve.canary', reason: 'See ![pixel](https://evil.example/p.png) and [here](https://evil.example) <img src=x onerror=alert(1)> <untrusted>' }, { agent: 'support', dir }, 0);
    expect(event.details.reason).toBe('See pixel and here');
  });
});

describe('improveSchedule', () => {
  it('is a schedule whose run is one watch tick', async () => {
    seedFailures();
    const schedule = improveSchedule({ ...options(), cron: '0 * * * *' });
    expect(isDefinedSchedule(schedule)).toBe(true);
    expect(schedule).toMatchObject({ cron: '0 * * * *', name: 'improve' });
    await schedule.run?.({ agent: undefined as never, firedAt: new Date(), name: 'improve' });
    expect(healOnce).toHaveBeenCalledTimes(1);
  });
});

describe('watchAgent', () => {
  it('ticks on its interval and stop() waits for the cycle in progress, then exits', async () => {
    seedFailures();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HealOptions['runCase'] = async (harness, input) => {
      await gate;
      return runCase(harness, input);
    };
    const cycles: string[] = [];
    const watcher = watchAgent(options({ runCase: slow, intervalMs: 60_000, onCycle: (cycle) => cycles.push(cycle.outcome) }));
    await vi.waitFor(() => expect(healOnce).toHaveBeenCalledTimes(1));
    const stopping = watcher.stop();
    release();
    await stopping;
    expect(healOnce).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(dir, 'instructions.md'), 'utf8').trim()).toBe(BASE);
    expect(readCycles(dir)[0]?.outcome).toBe('interrupted');
  });
});
