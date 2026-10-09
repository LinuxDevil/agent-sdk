import { describe, it, expect } from 'vitest';
import { graphFromTemplate } from '../templates';
import { graphToSpec } from '../../graph/graphToSpec';

describe('graphFromTemplate (Eve DUI-F21)', () => {
  it('names the spec after the id typed in "+ New agent"', () => {
    expect(graphToSpec(graphFromTemplate('support-bot', 'my-helper')).name).toBe('my-helper');
    expect(graphToSpec(graphFromTemplate('blank', 'scratch')).name).toBe('scratch');
  });

  it("keeps the template's own name when none is given", () => {
    expect(graphToSpec(graphFromTemplate('support-bot')).name).toBe('support-bot');
  });
});
