import { describe, expect, it } from 'vitest';
import { createAgent, textOf } from '../../src';
import { mockModel } from '../../src/testing';
import { RUBRIC, runEvaluatorLoop } from './index';

const PROMPT = 'Write a 3-sentence product description for HydraTrack.';

function writerFrom(script: Parameters<typeof mockModel>[0]) {
  return createAgent({
    name: 'writer',
    instructions: 'You write product copy. Revise when the critic gives feedback.',
    provider: mockModel(script),
  });
}

function lastUserText(model: ReturnType<typeof mockModel>): string {
  return textOf(model.calls.at(-1)!.messages.at(-1)!);
}

describe('examples/evaluator-loop', () => {
  it('revises on a failing score and returns the passing draft', async () => {
    const writerModel = mockModel([
      { text: 'HydraTrack is the best bottle ever.' },
      { text: 'HydraTrack chills to 4°C for 24 hours (ISO 22000 report).' },
    ]);
    // judge turns: one llmCritique() call per round returns SCORE +
    // FEEDBACK together.
    const judgeModel = mockModel([
      'SCORE: 0.4\nFEEDBACK: Cite a source for each claim and drop the unverifiable "best".',
      'SCORE: 0.9\nFEEDBACK: none',
    ]);

    const result = await runEvaluatorLoop({
      writer: createAgent({
        name: 'writer',
        instructions: 'You write product copy.',
        provider: writerModel,
      }),
      judge: { provider: judgeModel, model: 'mock-judge', rubric: RUBRIC },
      prompt: PROMPT,
      passScore: 0.8,
      maxRounds: 3,
    });

    expect(result.rounds).toBe(2);
    expect(result.score).toBeCloseTo(0.9);
    expect(result.text).toContain('ISO 22000');
    expect(result.history.map((entry) => entry.score)).toEqual([0.4, 0.9]);
    expect(result.history[0].feedback).toContain('Cite a source');
    expect(result.history[1].feedback).toBeUndefined();

    // The revision turn carried the critic's feedback back to the writer.
    expect(lastUserText(writerModel)).toContain('Cite a source for each claim');
    expect(lastUserText(writerModel)).toContain('scored 0.40');

    writerModel.assertExhausted();
    judgeModel.assertExhausted();
  });

  it('stops at maxRounds and returns the last draft when nothing passes', async () => {
    const writerModel = mockModel([{ text: 'draft v1' }, { text: 'draft v2' }, { text: 'draft v3' }]);
    // judge turns: one SCORE/FEEDBACK response per round - the final
    // round's note is discarded because no revision follows it.
    const judgeModel = mockModel([
      'SCORE: 0.2\nFEEDBACK: too thin',
      'SCORE: 0.3\nFEEDBACK: still thin',
      'SCORE: 0.35\nFEEDBACK: still thin',
    ]);

    const result = await runEvaluatorLoop({
      writer: createAgent({ name: 'writer', instructions: 'You write product copy.', provider: writerModel }),
      judge: { provider: judgeModel, model: 'mock-judge', rubric: RUBRIC },
      prompt: PROMPT,
      passScore: 0.8,
      maxRounds: 3,
    });

    expect(result.rounds).toBe(3);
    expect(result.score).toBeCloseTo(0.35);
    expect(result.text).toBe('draft v3');
    expect(result.history).toHaveLength(3);
    expect(result.history[2].feedback).toBeUndefined();
    writerModel.assertExhausted();
    judgeModel.assertExhausted();
  });

  it('stops after one round when the first draft passes', async () => {
    const judgeModel = mockModel(['SCORE: 0.95\nFEEDBACK: none']);
    const result = await runEvaluatorLoop({
      writer: writerFrom([{ text: 'perfect on the first try' }]),
      judge: { provider: judgeModel, model: 'mock-judge', rubric: RUBRIC },
      prompt: PROMPT,
      passScore: 0.8,
      maxRounds: 3,
    });

    expect(result.rounds).toBe(1);
    expect(result.text).toBe('perfect on the first try');
    expect(result.history[0].feedback).toBeUndefined();
    judgeModel.assertExhausted();
  });
});
