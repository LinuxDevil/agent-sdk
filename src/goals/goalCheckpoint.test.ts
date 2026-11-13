import { describe, expect, it } from 'vitest';
import { memoryStore } from '../storage/agentStore';
import type { GoalCheck, GoalSpec } from './contract';
import { progressOf, type GoalCheckpointStore } from './goalCheckpoint';
import { resumeGoal, runGoal, type GoalLead } from './runGoal';

function killAfter(store: GoalCheckpointStore, saves: number): GoalCheckpointStore {
  let count = 0;
  return {
    load: (id) => store.load(id),
    save: async (id, cp) => {
      await store.save(id, cp);
      count += 1;
      if (count === saves) throw new Error('process killed');
    },
  };
}

const goal: GoalSpec = { schema: 'lousho.goal/1', goal: 'Make it pass.', checks: [{ criterion: 'c' }], stop: { maxIterations: 10, maxCostUsd: 100 } };

const lead = (prompts: string[]): GoalLead => ({
  run: async (p, ctx) => {
    prompts.push(p);
    return { text: `t${ctx.iteration}`, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 } };
  },
});

const scoresFrom = (values: number[]): GoalCheck => {
  let i = 0;
  return async () => {
    const s = values[Math.min(i++, values.length - 1)];
    return { done: s >= 1, score: s, reason: `s${s}`, results: [] };
  };
};

describe('goal checkpoints', () => {
  it('a kill after iteration 4 resumes at iteration 5 with the same spend so far', async () => {
    const store = memoryStore().checkpoints;
    const first: string[] = [];
    await expect(runGoal({ lead: lead(first), goal, check: scoresFrom([0.1, 0.2, 0.3, 0.4]), runId: 'run-1', checkpoints: killAfter(store, 4) })).rejects.toThrow('process killed');
    expect(first).toHaveLength(4);
    const second: string[] = [];
    const result = await resumeGoal({ lead: lead(second), goal, check: scoresFrom([1]), runId: 'run-1', checkpoints: store });
    expect(second[0]).toContain('Iteration 5 of at most 10.');
    expect(second[0]).toContain('<untrusted>s0.4</untrusted>');
    expect(result.iterations.map((i) => i.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.iterations.map((i) => i.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.usage.costUsd).toBeCloseTo(1.25);
    expect(result.status).toBe('ok');
  });

  it('the remaining budget is the limit minus what was spent', async () => {
    const store = memoryStore().checkpoints;
    const budgetGoal: GoalSpec = { ...goal, stop: { ...goal.stop, maxCostUsd: 1.5 } };
    const first: string[] = [];
    await expect(runGoal({ lead: lead(first), goal: budgetGoal, check: scoresFrom([0.1, 0.2, 0.3, 0.4]), runId: 'run-1', checkpoints: killAfter(store, 4) })).rejects.toThrow('process killed');
    expect(first).toHaveLength(4);
    const second: string[] = [];
    const result = await resumeGoal({ lead: lead(second), goal: budgetGoal, check: scoresFrom([0.5]), runId: 'run-1', checkpoints: store });
    expect(result.outcome).toBe('budget');
    expect(result.iterations).toHaveLength(6);
  });

  it('the remaining duration counts the time already spent', async () => {
    let t = 0;
    const store = memoryStore().checkpoints;
    const timedGoal: GoalSpec = { ...goal, stop: { ...goal.stop, maxDurationMs: 900 } };
    const timed = (prompts: string[]): GoalLead => ({
      run: async (p, ctx) => {
        prompts.push(p);
        t += 300;
        return { text: `t${ctx.iteration}`, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25 } };
      },
    });
    const first: string[] = [];
    await expect(runGoal({ lead: timed(first), goal: timedGoal, check: scoresFrom([0.1, 0.2]), runId: 'run-1', checkpoints: killAfter(store, 2), now: () => t })).rejects.toThrow('process killed');
    expect(first).toHaveLength(2);
    const progress = progressOf((await store.load('run-1'))!);
    expect(progress?.elapsedMs).toBe(600);
    const second: string[] = [];
    const result = await resumeGoal({ lead: timed(second), goal: timedGoal, check: scoresFrom([0.3]), runId: 'run-1', checkpoints: store, now: () => t });
    expect(result.status).toBe('timed-out');
    expect(result.iterations).toHaveLength(3);
  });

  it('a finished goal run does not resume', async () => {
    const store = memoryStore().checkpoints;
    const result = await runGoal({ lead: lead([]), goal, check: scoresFrom([1]), runId: 'run-9', checkpoints: store });
    expect(result.status).toBe('ok');
    expect((await store.load('run-9'))?.status).toBe('finished');
    const throwing: GoalLead = {
      run: async () => {
        throw new Error('must not run');
      },
    };
    const resumed = await resumeGoal({ lead: throwing, goal, check: scoresFrom([0]), runId: 'run-9', checkpoints: store });
    expect(resumed).toEqual(result);
  });

  it('resume without a checkpoint is LOUSHO_CHECKPOINT_NOT_FOUND', async () => {
    const store = memoryStore().checkpoints;
    await expect(resumeGoal({ lead: lead([]), goal, check: scoresFrom([0]), runId: 'none', checkpoints: store })).rejects.toMatchObject({ code: 'LOUSHO_CHECKPOINT_NOT_FOUND' });
  });

  it('runId without checkpoints is LOUSHO_CONFIG_INVALID', async () => {
    await expect(runGoal({ lead: lead([]), goal, check: scoresFrom([0]), runId: 'run-1' })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });

  it('checkpoints are saved under the page run id after every iteration', async () => {
    const saved: { id: string; stepIndex: number; status?: string }[] = [];
    const spy: GoalCheckpointStore = {
      load: async () => null,
      save: async (id, cp) => {
        saved.push({ id, stepIndex: cp.stepIndex, status: cp.status });
      },
    };
    await runGoal({ lead: lead([]), goal, check: scoresFrom([0.1, 0.2, 1]), runId: 'run-7', checkpoints: spy });
    expect(saved).toHaveLength(4);
    expect(saved.every((s) => s.id === 'run-7')).toBe(true);
    expect(saved.slice(0, 3).map((s) => s.stepIndex)).toEqual([1, 2, 3]);
    expect(saved.slice(0, 3).every((s) => s.status === 'in-progress')).toBe(true);
    expect(saved[3]?.status).toBe('finished');
  });
});
