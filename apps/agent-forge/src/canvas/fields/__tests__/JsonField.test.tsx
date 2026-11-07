import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { JsonField, type JsonFieldProps } from '../JsonField';

let container: HTMLDivElement;
const render = (props: Partial<JsonFieldProps> = {}) => {
  container = mount(<JsonField id="node-tool-options" label="Options" value={undefined} onChange={vi.fn()} {...props} />);
};

const textarea = () => container.querySelector('textarea')!;
const fieldError = () => container.querySelector('.field-error')?.textContent ?? undefined;

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const blur = (el: Element) => act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

describe('JsonField', () => {
  it('emits the parsed value on blur and keeps the draft formatting', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(textarea(), '{"a":1}');
    blur(textarea());
    expect(onChange).toHaveBeenLastCalledWith({ a: 1 });
    expect(fieldError()).toBeUndefined();
    expect(textarea().value).toBe('{"a":1}');
  });

  it('pretty-prints an existing value', () => {
    render({ value: { a: 1 } });
    expect(textarea().value).toBe('{\n  "a": 1\n}');
  });

  it('keeps the draft and shows the parse error for invalid JSON', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(textarea(), '{bad');
    blur(textarea());
    expect(onChange).not.toHaveBeenCalled();
    expect(textarea().value).toBe('{bad');
    expect(fieldError()).toContain('This is not valid JSON:');
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the check message and does not emit', () => {
    const onChange = vi.fn();
    render({
      onChange,
      check: (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? undefined : 'Options must be a JSON object'),
    });
    type(textarea(), '[1]');
    blur(textarea());
    expect(onChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe('Options must be a JSON object');
  });

  it('emits undefined for empty text', () => {
    const onChange = vi.fn();
    render({ onChange, value: { a: 1 } });
    type(textarea(), '');
    blur(textarea());
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
