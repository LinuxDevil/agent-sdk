import { describe, expect, it } from 'vitest';
import type { GoalCheck, GoalSpec, GoalStop } from './contract';
import { goalStepCounter, runGoal, type GoalLead, type GoalStepEvent } from './runGoal';

const goal = (stop: Partial<GoalStop> = {}): GoalSpec => ({
  schema: 'lousho.goal/1',
  goal: 'Make it pass.',
  checks: [{ criterion: 'c' }],
  stop: { maxIterations: 5, maxCostUsd: 10, ...stop },
});

const scores = (...values: number[]): GoalCheck => {
  let i = 0;
  return async () => {
    const score = values[Math.min(i++, values.length - 1)];
    return { done: score >= 1, score, reason: `score ${score}`, results: [] };
  };
};

function lead(cost = 0.1, onRun?: (prompt: string, ctx: { iteration: number; stepIndex: number }) => void): GoalLead & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    run: async (prompt, ctx) => {
      prompts.push(prompt);
      onRun?.(prompt, ctx);
      return { text: `turn ${ctx.iteration}`, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: cost } };
    },
  };
}

describe('runGoal', () => {
  it('stops at maxCostUsd before maxIterations', async () => {
    const result = await runGoal({ lead: lead(0.6), goal: goal({ maxIterations: 5, maxCostUsd: 1 }), check: scores(0.1, 0.2, 0.3, 0.4, 0.5) });
    expect(result.outcome).toBe('budget');
    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('budget');
    expect(result.iterations).toHaveLength(2);
    expect(result.usage.costUsd).toBeCloseTo(1.2);
  });

  it('the run spend cap applies on top of the goal cap', async () => {
    const result = await runGoal({ lead: lead(0.1), goal: goal({ maxCostUsd: 10 }), limits: { maxCostUsd: 0.25 }, check: scores(0.1, 0.2, 0.3, 0.4) });
    expect(result.iterations).toHaveLength(3);
    expect(result.outcome).toBe('budget');
  });

  it('each iteration emits goal-iteration with its index', async () => {
    const events: GoalStepEvent[] = [];
    const result = await runGoal({ lead: lead(), goal: goal(), check: scores(0.2, 0.4, 1), emit: (e) => events.push(e) });
    expect(events).toEqual([
      { kind: 'goal-iteration', phase: 'start', iteration: 1, stepIndex: 0 },
      { kind: 'goal-iteration', phase: 'done', iteration: 1, stepIndex: 0 },
      { kind: 'goal-iteration', phase: 'start', iteration: 2, stepIndex: 1 },
      { kind: 'goal-iteration', phase: 'done', iteration: 2, stepIndex: 1 },
      { kind: 'goal-iteration', phase: 'start', iteration: 3, stepIndex: 2 },
      { kind: 'goal-iteration', phase: 'done', iteration: 3, stepIndex: 2 },
    ]);
    expect(result.outcome).toBe('done');
    expect(result.status).toBe('ok');
  });

  it('a delegate failure inside iteration 3 is labelled iteration 3', async () => {
    const delegateEvents: { parentStepIndex: number }[] = [];
    const steps = goalStepCounter();
    const failing: GoalLead = {
      run: async (_p, ctx) => {
        if (ctx.iteration === 3) {
          delegateEvents.push({ parentStepIndex: ctx.stepIndex });
          steps.next();
          throw new Error("The 'video' agent failed: render error");
        }
        return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
      },
    };
    const events: GoalStepEvent[] = [];
    const result = await runGoal({ lead: failing, goal: goal(), check: scores(0.1, 0.2), steps, emit: (e) => events.push(e) });
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({ kind: 'engine', message: "iteration 3: The 'video' agent failed: render error", iteration: 3 });
    const third = events.find((e) => e.iteration === 3 && e.phase === 'start')!;
    expect(delegateEvents).toEqual([{ parentStepIndex: third.stepIndex }]);
    expect(events.filter((e) => e.iteration === 3).map((e) => e.phase)).toEqual(['start', 'done']);
  });

  it('stall stops the loop', async () => {
    const result = await runGoal({ lead: lead(), goal: goal({ stallAfter: 2 }), check: scores(0.5, 0.5, 0.5, 0.9) });
    expect(result.outcome).toBe('stalled');
    expect(result.error?.kind).toBe('stalled');
    expect(result.iterations).toHaveLength(3);
  });

  it('onStall continue keeps going to maxIterations', async () => {
    const result = await runGoal({ lead: lead(), goal: goal({ onStall: 'continue', stallAfter: 1, maxIterations: 4 }), check: scores(0.5) });
    expect(result.outcome).toBe('max-iterations');
    expect(result.iterations).toHaveLength(4);
  });

  it('stops at maxIterations', async () => {
    const result = await runGoal({ lead: lead(), goal: goal({ maxIterations: 2 }), check: scores(0.1, 0.2) });
    expect(result.outcome).toBe('max-iterations');
    expect(result.iterations).toHaveLength(2);
  });

  it('stops at maxDurationMs as timed-out', async () => {
    let t = 0;
    const timed: GoalLead = {
      run: async () => {
        t += 400;
        return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
      },
    };
    const result = await runGoal({ lead: timed, goal: goal({ maxDurationMs: 1000 }), check: scores(0.1, 0.2, 0.3, 0.4), now: () => t });
    expect(result.status).toBe('timed-out');
    expect(result.error?.kind).toBe('timeout');
    expect(result.iterations).toHaveLength(3);
  });

  it('stops on the token ceiling', async () => {
    const result = await runGoal({ lead: lead(), goal: goal(), limits: { maxTokens: 30 }, check: scores(0.1) });
    expect(result.iterations).toHaveLength(2);
    expect(result.outcome).toBe('budget');
  });

  it('the check reason reaches the next prompt inside untrusted markers', async () => {
    const l = lead();
    const result = await runGoal({ lead: l, goal: goal(), check: scores(0.1, 1) });
    expect(result.outcome).toBe('done');
    expect(l.prompts[1]).toContain('Iteration 2 of at most 5.');
    expect(l.prompts[1]).toContain('<untrusted>score 0.1</untrusted>');
    expect(l.prompts[0]).toContain('Goal: Make it pass.');
  });

  it('the first prompt names the delegates', async () => {
    const l = lead();
    await runGoal({ lead: l, delegates: ['video', 'voice'], goal: goal(), check: scores(1) });
    expect(l.prompts[0]).toContain('You may delegate to: video, voice.');
  });

  it('an abort ends with cancelled', async () => {
    const controller = new AbortController();
    const aborting: GoalLead = {
      run: async () => {
        controller.abort();
        return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
      },
    };
    const result = await runGoal({ lead: aborting, goal: goal(), check: scores(0.1), signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.outcome).toBe('aborted');
  });

  it('a long reason is clipped to 500 characters', async () => {
    const l = lead();
    const check: GoalCheck = async () => ({ done: false, score: 0.1, reason: 'x'.repeat(2000), results: [] });
    await runGoal({ lead: l, goal: goal(), check });
    const between = l.prompts[1].split('<untrusted>')[1].split('</untrusted>')[0];
    expect(between).toHaveLength(500);
  });
});
