import { describe, it, expectTypeOf } from 'vitest';
import type { EditorStep } from '../types/flow';

describe('EditorStep covers every node kind FlowExecutor runs', () => {
  it('accepts executor-side nodes without a cast', () => {
    const steps: EditorStep = {
      type: 'sequence',
      steps: [
        { type: 'llmCall', prompt: 'Hi {{name}}', model: 'm', temperature: 0, maxTokens: 10, outputVariable: 'out' },
        { type: 'toolCall', tool: 'search', arguments: { q: '{{out}}' }, outputVariable: 'hits' },
        { type: 'setVariable', variable: 'n', value: 1 },
        { type: 'forEach', items: '$hits', itemVariable: 'hit', indexVariable: 'i', step: { type: 'end', value: '$hit' } },
        { type: 'evaluator', expression: 'n > 0' },
        {
          type: 'oneOf',
          options: [
            { condition: "'{{out}}' === 'a'", step: { type: 'return', value: 'a' } },
            { step: { type: 'throw', message: 'no' } },
          ],
        },
      ],
    };
    expectTypeOf(steps).toMatchTypeOf<EditorStep>();
  });

  it('still accepts the editor-side shapes', () => {
    const steps: EditorStep[] = [
      { type: 'step', agent: 'a', input: 'x' },
      { type: 'oneOf', branches: [{ when: 'true', flow: { type: 'step', agent: 'a', input: 'x' } }] },
      { type: 'condition', condition: 'true', trueFlow: { type: 'end' }, falseFlow: { type: 'end' } },
    ];
    expectTypeOf(steps).toMatchTypeOf<EditorStep[]>();
  });

  it('rejects an unknown node type and wrong field types', () => {
    // @ts-expect-error - not a node kind
    const bad: EditorStep = { type: 'nope' };
    // @ts-expect-error - llmCall prompt must be a string
    const bad2: EditorStep = { type: 'llmCall', prompt: 3 };
    void bad;
    void bad2;
  });
});
