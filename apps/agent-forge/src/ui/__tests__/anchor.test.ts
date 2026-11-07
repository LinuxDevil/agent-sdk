import { describe, expect, it } from 'vitest';
import { anchorStyle } from '../anchor';

const rect = { left: 100, right: 140, top: 50, bottom: 82, width: 40, height: 32 } as DOMRect;
const viewport = { width: 1000, height: 800 };
const popup = { width: 180, height: 120 };

describe('anchorStyle', () => {
  it('places below the rect, end-aligned, clamped into the viewport', () => {
    // left = rect.right - w = 140 - 180 = -40 -> clamped to 8.
    expect(anchorStyle(rect, popup, { side: 'bottom', align: 'end', offset: 4, viewport })).toEqual({
      top: 86,
      left: 8,
      side: 'bottom',
    });
  });

  it('aligns start to rect.left and center to the rect midpoint', () => {
    expect(anchorStyle(rect, popup, { side: 'bottom', align: 'start', offset: 4, viewport }).left).toBe(100);
    expect(anchorStyle(rect, popup, { side: 'bottom', align: 'center', offset: 4, viewport }).left).toBe(30);
  });

  it('flips above when the popup would leave the viewport and there is room', () => {
    const low = { ...rect, top: 700, bottom: 732 } as DOMRect;
    // top = 732 + 4 = 736; 736 + 120 > 800 - 8 and 700 - 4 - 120 = 576 >= 8 -> flip.
    expect(anchorStyle(low, popup, { side: 'bottom', align: 'start', offset: 4, viewport })).toEqual({
      top: 576,
      left: 100,
      side: 'top',
    });
  });

  it('keeps side top when it fits, flips below when it would leave the viewport', () => {
    const tip = { width: 120, height: 30 };
    // top = 50 - 6 - 30 = 14 >= 8 -> stays.
    expect(anchorStyle(rect, tip, { side: 'top', align: 'center', offset: 6, viewport })).toEqual({
      top: 14,
      left: 60,
      side: 'top',
    });
    const high = { ...rect, top: 20, bottom: 52 } as DOMRect;
    // top = 20 - 6 - 30 = -16 < 8 -> flip: top = 52 + 6 = 58.
    expect(anchorStyle(high, tip, { side: 'top', align: 'center', offset: 6, viewport })).toEqual({
      top: 58,
      left: 60,
      side: 'bottom',
    });
  });
});
