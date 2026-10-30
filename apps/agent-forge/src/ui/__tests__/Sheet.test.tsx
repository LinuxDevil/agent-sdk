import { act, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, rerender } from './render';
import { Sheet } from '../Sheet';

const noop = () => {};

const key = (k: string, target: Element, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });

const mouseDown = (target: Element) =>
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });

const sheet = () => document.querySelector('.sheet') as HTMLElement | null;

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    render(<Sheet open={false} onClose={noop} title="Import agent">body</Sheet>);
    expect(document.querySelector('.sheet')).toBeNull();
    expect(document.querySelector('.overlay-scrim')).toBeNull();
  });

  it('opens portalled to document.body with labelled title and described body', () => {
    const host = render(
      <Sheet open onClose={noop} title="Import agent" description="Paste YAML." size="xl">
        body
      </Sheet>,
    );
    const el = sheet()!;
    expect(el.className).toBe('sheet sheet-xl');
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    const labelledby = document.getElementById(el.getAttribute('aria-labelledby')!)!;
    expect(labelledby.tagName).toBe('H2');
    expect(labelledby.textContent).toBe('Import agent');
    const describedby = document.getElementById(el.getAttribute('aria-describedby')!)!;
    expect(describedby.textContent).toBe('Paste YAML.');
    // Inside .screen-main (container-type: size) fixed positioning breaks, so the portal must land on body.
    expect(el.parentElement).toBe(document.querySelector('.overlay-scrim'));
    expect(el.parentElement!.parentElement).toBe(document.body);
    expect(host.contains(el)).toBe(false);
    expect(el.getAttribute('tabindex')).toBe('-1');
  });

  it('omits aria-describedby without a description', () => {
    render(<Sheet open onClose={noop} title="Import agent">body</Sheet>);
    expect(sheet()!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('moves focus in on open and back to the opener on close', () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    try {
      render(<Sheet open onClose={noop} title="T">plain text</Sheet>);
      // First focusable in DOM order is the header's close button.
      expect(document.activeElement).toBe(sheet()!.querySelector('.sheet-close'));
      rerender(<Sheet open={false} onClose={noop} title="T">plain text</Sheet>);
      expect(document.activeElement).toBe(opener);

      function WithInitialFocus() {
        const field = useRef<HTMLInputElement>(null);
        return (
          <Sheet open onClose={noop} title="T" initialFocus={field}>
            <input ref={field} />
          </Sheet>
        );
      }
      render(<WithInitialFocus />);
      expect(document.activeElement).toBe(sheet()!.querySelector('input'));
    } finally {
      opener.remove();
    }
  });

  it('Escape keydown and scrim mousedown close; mousedown inside does not', () => {
    const onClose = vi.fn();
    render(<Sheet open onClose={onClose} title="T">body</Sheet>);
    key('Escape', sheet()!);
    expect(onClose).toHaveBeenCalledTimes(1);
    mouseDown(document.querySelector('.sheet-body')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    mouseDown(sheet()!);
    expect(onClose).toHaveBeenCalledTimes(1);
    mouseDown(document.querySelector('.overlay-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps Tab and Shift+Tab inside the panel', () => {
    render(
      <Sheet open onClose={noop} title="T">
        <button type="button">A</button>
        <button type="button">B</button>
      </Sheet>,
    );
    const close = sheet()!.querySelector('.sheet-close')!;
    const [a, b] = [...sheet()!.querySelectorAll<HTMLButtonElement>('.sheet-body button')];
    // DOM order: close, A, B. Opening put focus on close.
    expect(document.activeElement).toBe(close);
    key('Tab', close);
    expect(document.activeElement).toBe(a);
    key('Tab', a!);
    expect(document.activeElement).toBe(b);
    // Tab from the last focusable wraps to the first.
    key('Tab', b!);
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first wraps to the last.
    key('Tab', close, { shiftKey: true });
    expect(document.activeElement).toBe(b);
    key('Tab', b!, { shiftKey: true });
    expect(document.activeElement).toBe(a);
  });

  it('renders a footer row only when footer is given', () => {
    render(
      <Sheet open onClose={noop} title="T" footer={<button type="button">Done</button>}>
        body
      </Sheet>,
    );
    const footer = document.querySelector('footer.sheet-footer')!;
    expect(footer.textContent).toBe('Done');
    expect(footer.querySelector('button')!.textContent).toBe('Done');
    rerender(<Sheet open onClose={noop} title="T">body</Sheet>);
    expect(document.querySelector('.sheet-footer')).toBeNull();
  });
});
