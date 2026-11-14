import { describe, expect, it } from 'vitest';
import { checkPageInputs } from './inputs';

const schema = { type: 'object', properties: { topic: { type: 'string' }, tone: { type: 'string', enum: ['friendly', 'formal'] } }, required: ['topic'] };

describe('checkPageInputs', () => {
  it('is empty for valid inputs', () => {
    expect(checkPageInputs(schema, { topic: 'Composting', tone: 'formal' })).toEqual([]);
  });

  it('reports a missing required field and a value outside the enum at their inputs paths', () => {
    expect(checkPageInputs(schema, { tone: 'shouty' }).map((problem) => problem.path).sort()).toEqual(['inputs.tone', 'inputs.topic']);
  });

  it('reports missing inputs at the root', () => {
    expect(checkPageInputs(schema, undefined).map((problem) => problem.path)).toEqual(['inputs']);
  });
});
