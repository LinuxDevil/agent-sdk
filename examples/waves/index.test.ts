import { describe, expect, it } from 'vitest';
import { createAgent } from '../../src';
import { mockModel } from '../../src/testing';
import { runWaves } from './index';

/** A worker factory handing each new agent the next scripted line. */
function worker(scripted: string[]) {
  const calls = { i: 0 };
  const models: ReturnType<typeof mockModel>[] = [];
  const factory = () => {
    const model = mockModel([{ text: scripted[calls.i++] }]);
    models.push(model);
    return createAgent({ name: 'w', instructions: 'summarize', provider: model });
  };
  return Object.assign(factory, {
    models,
    /** The prompt each worker received, in factory-call order. */
    prompts: () => models.map((m) => String(m.calls[0]?.messages.at(-1)?.content)),
  });
}

const verifier = (script: object[]) => ({
  provider: mockModel(script.map((v) => ({ text: JSON.stringify(v) }))),
  model: 'mock-verifier',
});

const opts = {
  aggregate: (t: string, o: string) => `${t} => ${o}`,
  verifyPrompt: (a: string) => `judge: ${a}`,
  gapToTask: (g: string) => `cover ${g}`,
};

describe('examples/waves', () => {
  it('passes in one wave when the verifier approves', async () => {
    const w = worker(['a', 'b']);
    const result = await runWaves({
      worker: w,
      verifier: verifier([{ verdict: 'pass', gaps: [] }]),
      tasks: ['t1', 't2'],
      ...opts,
      maxWaves: 3,
      concurrency: 2,
    });
    expect(result.waves).toBe(1);
    expect(result.verdict.verdict).toBe('pass');
    expect(result.outputs[0]).toEqual(['a', 'b']);
    expect(result.aggregate).toContain('t1 => a');
    expect(result.aggregate).toContain('t2 => b');
    // Each worker was asked its own task.
    expect(w.prompts()).toEqual(['t1', 't2']);
  });

  it('extends: gaps from wave 1 seed the wave-2 task list', async () => {
    const w = worker(['out0', 'out1']);
    const result = await runWaves({
      worker: w,
      verifier: verifier([
        { verdict: 'extend', gaps: ['the missing piece'] },
        { verdict: 'pass', gaps: [] },
      ]),
      tasks: ['t1'],
      ...opts,
      maxWaves: 3,
      concurrency: 2,
    });
    expect(result.waves).toBe(2);
    // The verifier's gap became the second wave's task.
    expect(w.prompts()).toEqual(['t1', 'cover the missing piece']);
    expect(result.aggregate).toContain('cover the missing piece => out1');
  });

  it('an extend verdict with no gaps ends the loop instead of spinning', async () => {
    const result = await runWaves({
      worker: worker(['x']),
      verifier: verifier([{ verdict: 'extend', gaps: [] }]),
      tasks: ['t1'],
      ...opts,
      maxWaves: 3,
      concurrency: 1,
    });
    expect(result.waves).toBe(1);
    expect(result.verdict.verdict).toBe('pass');
  });

  it('stops at maxWaves even while still failing', async () => {
    const result = await runWaves({
      worker: worker(['x', 'y']),
      verifier: verifier([
        { verdict: 'extend', gaps: ['g1'] },
        { verdict: 'extend', gaps: ['g2'] },
      ]),
      tasks: ['t1'],
      ...opts,
      maxWaves: 2,
      concurrency: 1,
    });
    expect(result.waves).toBe(2);
    expect(result.verdict.verdict).toBe('extend');
  });

  it('a failed worker propagates rather than verifying a partial aggregate', async () => {
    const failing = () =>
      createAgent({
        name: 'w',
        instructions: 'x',
        provider: mockModel([{ error: new Error('boom') }]),
      });
    await expect(
      runWaves({
        worker: failing,
        verifier: verifier([]),
        tasks: ['t1'],
        ...opts,
        maxWaves: 1,
        concurrency: 1,
      })
    ).rejects.toThrow('boom');
  });
});
