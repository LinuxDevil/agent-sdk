import { describe, it, expect } from 'vitest';
import type { AgentEventUsage } from './agentEvents';
import { emptyRunUsage, fromEventUsage, measureUsage, mergeDelegatedUsage, recordStepUsage, remoteModelKey, restoreRunUsage, usageSince } from './runUsage';

const event = (inputTokens: number, outputTokens: number, extra: Partial<AgentEventUsage> = {}): AgentEventUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  promptTokens: inputTokens,
  completionTokens: outputTokens,
  estimated: false,
  ...extra,
});

describe('remote sub-agent usage helpers (M10b)', () => {
  it('fromEventUsage files the totals under one remote entry, one call by default', () => {
    const usage = fromEventUsage(event(100, 50, { costUsd: 0.5, estimated: true }), remoteModelKey('researcher'));
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.5,
      modelCalls: 1,
      estimated: true,
      byModel: { 'remote:researcher': { inputTokens: 100, outputTokens: 50, calls: 1, costUsd: 0.5 } },
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(fromEventUsage(event(1, 1, { modelCalls: 3 }), 'remote:r')).toMatchObject({ modelCalls: 3, costUsd: undefined });
  });

  it("adds the remote's own cost to a priced lead's cost, and keeps it through a checkpoint", () => {
    const run = emptyRunUsage();
    recordStepUsage(run, { model: 'gpt-4o-mini', usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, estimated: false });
    const leadCost = run.costUsd!;
    expect(leadCost).toBeGreaterThan(0);

    mergeDelegatedUsage(run, fromEventUsage(event(10, 5, { costUsd: 0.25 }), 'remote:r'));
    mergeDelegatedUsage(run, fromEventUsage(event(10, 5, { costUsd: 0.25 }), 'remote:r'));

    expect(run.byModel['remote:r']).toEqual({ inputTokens: 20, outputTokens: 10, calls: 2, costUsd: 0.5 });
    expect(run.costUsd).toBeCloseTo(leadCost + 0.5);
    expect(restoreRunUsage(structuredClone(run)).costUsd).toBeCloseTo(leadCost + 0.5);
  });

  it("makes the lead's cost unknown when the remote sent no cost", () => {
    const run = emptyRunUsage();
    recordStepUsage(run, { model: 'gpt-4o-mini', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, estimated: false });
    mergeDelegatedUsage(run, fromEventUsage(event(10, 5, { costUsd: 0.25 }), 'remote:r'));
    mergeDelegatedUsage(run, fromEventUsage(event(10, 5), 'remote:r'));
    expect(run.byModel['remote:r'].costUsd).toBeUndefined();
    expect(run.costUsd).toBeUndefined();
    expect(run.delegated?.costUsd).toBeUndefined();
  });

  it('usageSince is what a cumulative total added after an earlier one, never below zero', () => {
    const before = fromEventUsage(event(100, 10, { costUsd: 0.1 }), 'remote:r');
    const now = fromEventUsage(event(300, 30, { costUsd: 0.4, modelCalls: 2 }), 'remote:r');
    expect(usageSince(now, undefined)).toBe(now);
    const delta = usageSince(now, before);
    expect(delta).toMatchObject({ inputTokens: 200, outputTokens: 20, totalTokens: 220, modelCalls: 1, promptTokens: 200, completionTokens: 20 });
    expect(delta.costUsd).toBeCloseTo(0.3);
    expect(delta.byModel['remote:r']).toMatchObject({ inputTokens: 200, outputTokens: 20, calls: 1 });
    expect(delta.byModel['remote:r'].costUsd).toBeCloseTo(0.3);

    const smaller = usageSince(before, now);
    expect(smaller).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0, costUsd: 0 });
    expect(usageSince(fromEventUsage(event(5, 5), 'remote:r'), before).costUsd).toBeUndefined();
    expect(usageSince(now, fromEventUsage(event(1, 1), 'remote:other')).byModel['remote:r'].costUsd).toBe(0.4);
  });
});

describe('provider-reported cost (Eve PROV-F3)', () => {
  const generated = (costUsd?: number) => ({ text: 'x', finishReason: 'stop' as const, usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, costUsd } });

  it('prefers the reported cost over the registry estimate, even for a priced model', () => {
    expect(measureUsage('gpt-4o-mini', [], generated(2)).costUsd).toBe(2);
    expect(measureUsage('gpt-4o-mini', [], generated()).costUsd).toBeCloseTo((100 * 0.15 + 10 * 0.6) / 1_000_000);
  });

  it('totals reported costs for a model the registry does not know, and keeps them through a checkpoint', () => {
    const run = emptyRunUsage();
    for (let i = 0; i < 3; i++) recordStepUsage(run, measureUsage('some/unpriced-model', [], generated(2)));
    expect(run.costUsd).toBe(6);
    expect(run.byModel['some/unpriced-model'].costUsd).toBe(6);
    expect(restoreRunUsage(structuredClone(run)).costUsd).toBe(6);
  });
});
