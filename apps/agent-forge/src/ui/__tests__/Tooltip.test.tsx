import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from './render';
import { Tooltip } from '../Tooltip';

const tooltip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]');

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after the 300ms delay on focus, links via aria-describedby, closes on blur', () => {
    const host = render(
      <Tooltip content="Explain me">
        <button type="button">Target</button>
      </Tooltip>,
    );
    const btn = host.querySelector('button')!;
    act(() => {
      btn.focus();
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(tooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = tooltip()!;
    expect(tip).not.toBeNull();
    expect(tip.parentElement).toBe(document.body);
    expect(tip.textContent).toBe('Explain me');
    expect(tip.className).toContain('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
    act(() => {
      btn.blur();
    });
    expect(tooltip()).toBeNull();
    expect(btn.hasAttribute('aria-describedby')).toBe(false);
  });

  it('opens on mouseenter and closes on mouseleave and on Escape', () => {
    const host = render(
      <Tooltip content="Why it is off">
        <span tabIndex={0}>wrapped target</span>
      </Tooltip>,
    );
    const target = host.querySelector('span')!;
    // React's onMouseEnter/onMouseLeave are synthesized from mouseover/mouseout.
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(tooltip()).not.toBeNull();
    // Escape on the window (the tooltip never takes focus) also dismisses.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(tooltip()).toBeNull();
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(tooltip()).not.toBeNull();
    act(() => {
      target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(tooltip()).toBeNull();
  });
});
