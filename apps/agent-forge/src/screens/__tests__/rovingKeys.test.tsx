import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { onRovingKeyDown } from '../rovingKeys';

function mount(count = 3) {
  const container = render(
    <div className="list" onKeyDown={onRovingKeyDown}>
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" data-roving>
          {`item ${i}`}
        </button>
      ))}
      <button type="button" className="outside">
        outside
      </button>
    </div>,
  );
  const list = container.querySelector<HTMLElement>('.list')!;
  const items = [...container.querySelectorAll<HTMLButtonElement>('[data-roving]')];
  return { list, items };
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('onRovingKeyDown', () => {
  it.each(['j', 'ArrowDown'])('%s moves focus to the next item', (key) => {
    const { items } = mount();
    items[0].focus();
    const event = press(items[0], key);
    expect(document.activeElement).toBe(items[1]);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(['k', 'ArrowUp'])('%s moves focus to the previous item', (key) => {
    const { items } = mount();
    items[2].focus();
    const event = press(items[2], key);
    expect(document.activeElement).toBe(items[1]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('clamps at both ends of the list', () => {
    const { items } = mount();
    items[2].focus();
    press(items[2], 'j');
    expect(document.activeElement).toBe(items[2]);
    items[0].focus();
    press(items[0], 'k');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Home and End jump to the first and last item', () => {
    const { items } = mount();
    items[1].focus();
    const end = press(items[1], 'End');
    expect(document.activeElement).toBe(items[2]);
    expect(end.defaultPrevented).toBe(true);
    const home = press(items[2], 'Home');
    expect(document.activeElement).toBe(items[0]);
    expect(home.defaultPrevented).toBe(true);
  });

  it.each(['j', 'ArrowDown', 'k', 'ArrowUp'])('%s from outside the roving items lands on the first item', (key) => {
    const { list } = mount();
    const outside = list.querySelector<HTMLButtonElement>('.outside')!;
    outside.focus();
    press(outside, key);
    expect(document.activeElement).toBe(list.querySelector('[data-roving]'));
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }])('ignores keys with modifiers %o', (init) => {
    const { items } = mount();
    items[0].focus();
    const event = press(items[0], 'j', init);
    expect(document.activeElement).toBe(items[0]);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['Enter', ' ', 'x', 'Tab'])('leaves %o to the buttons', (key) => {
    const { items } = mount();
    items[1].focus();
    const event = press(items[1], key);
    expect(document.activeElement).toBe(items[1]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does nothing when the list has no roving items', () => {
    const { list } = mount(0);
    const outside = list.querySelector<HTMLButtonElement>('.outside')!;
    outside.focus();
    const event = press(outside, 'End');
    expect(document.activeElement).toBe(outside);
    expect(event.defaultPrevented).toBe(false);
  });
});
