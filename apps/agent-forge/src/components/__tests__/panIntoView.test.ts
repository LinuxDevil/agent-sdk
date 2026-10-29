import { describe, expect, it } from 'vitest';
import { panIntoView } from '../CanvasArea';

// A 540x500 pane (the 1280px builder with the Inspector open); the margin kept from each edge is 24px.
describe('panIntoView', () => {
  it('leaves a node that is already inside the pane alone', () => {
    expect(panIntoView({ left: 100, top: 100, width: 160, height: 60 }, 540, 500)).toEqual({ dx: 0, dy: 0 });
  });

  it('pans left just enough to bring a node cut off on the right back in', () => {
    // The Output node at 700..860 once the Inspector narrows the pane: its right edge lands at 540 - 24.
    expect(panIntoView({ left: 700, top: 200, width: 160, height: 60 }, 540, 500)).toEqual({ dx: -344, dy: 0 });
  });

  it('pans right / down for a node off the left / top edge', () => {
    expect(panIntoView({ left: -50, top: -10, width: 160, height: 60 }, 540, 500)).toEqual({ dx: 74, dy: 34 });
  });

  it('keeps the left edge in view when the node is wider than the pane', () => {
    expect(panIntoView({ left: 300, top: 100, width: 800, height: 60 }, 540, 500)).toEqual({ dx: -276, dy: 0 });
  });
});
