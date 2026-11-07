import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { StringListField, type StringListFieldProps } from '../StringListField';

let container: HTMLDivElement;
const render = (props: Partial<StringListFieldProps> = {}) => {
  container = mount(
    <StringListField id="node-agent-fallbacks" label="Fallback models" value={undefined} onChange={vi.fn()} {...props} />,
  );
};

const input = () => container.querySelector('input')!;
const chips = () => [...container.querySelectorAll('.chip')].map((chip) => chip.firstChild!.textContent);
const fieldError = () => container.querySelector('.field-error')?.textContent ?? undefined;

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const enter = (el: HTMLInputElement) =>
  act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
const click = (el: Element) => act(() => (el as HTMLElement).click());

describe('StringListField', () => {
  it('adds the draft on Enter and renders it as a chip', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(input(), 'openai/gpt-4o');
    enter(input());
    expect(onChange).toHaveBeenLastCalledWith(['openai/gpt-4o']);
    expect(input().value).toBe('');
  });

  it('adds items on comma and keeps the tail as the draft', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(input(), 'a,b,c');
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    expect(input().value).toBe('c');
  });

  it('ignores a duplicate item', () => {
    const onChange = vi.fn();
    render({ onChange, value: ['a'] });
    type(input(), 'a');
    enter(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('shows the validateItem message and keeps the draft for a rejected item', () => {
    const onChange = vi.fn();
    render({ onChange, validateItem: (item) => (item === 'bad' ? 'Not a known model' : undefined) });
    type(input(), 'bad');
    enter(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe('Not a known model');
    expect(input().value).toBe('bad');
  });

  it('renders chips with labelled remove buttons', () => {
    render({ value: ['a', 'b'] });
    expect(chips()).toEqual(['a', 'b']);
    expect(container.querySelector('button[aria-label="Remove a"]')).not.toBeNull();
  });

  it('removes a chip', () => {
    const onChange = vi.fn();
    render({ onChange, value: ['a', 'b'] });
    click(container.querySelector('button[aria-label="Remove a"]')!);
    expect(onChange).toHaveBeenLastCalledWith(['b']);
  });

  it('emits undefined when the last chip is removed', () => {
    const onChange = vi.fn();
    render({ onChange, value: ['a'] });
    click(container.querySelector('button[aria-label="Remove a"]')!);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
