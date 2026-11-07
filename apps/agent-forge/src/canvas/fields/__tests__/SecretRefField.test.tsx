import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { SecretRefField, type SecretRefFieldProps } from '../SecretRefField';

let container: HTMLDivElement;
const render = (props: Partial<SecretRefFieldProps> = {}) => {
  container = mount(
    <SecretRefField id="node-mcp-token" label="Token" value={undefined} onChange={vi.fn()} {...props} />,
  );
};

const input = () => container.querySelector('input')!;
const select = () => container.querySelector('select')!;
const fieldError = () => container.querySelector('.field-error')?.textContent ?? undefined;

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SecretRefField', () => {
  it('labels the name input and offers env + secret kinds', () => {
    render();
    const label = container.querySelector('label.field-label')!;
    expect(label.getAttribute('for')).toBe(input().id);
    const options = [...select().querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['Environment variable', 'Studio secret']);
  });

  it('emits { env: name } for a valid environment-variable name', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(input(), 'GITHUB_TOKEN');
    expect(onChange).toHaveBeenLastCalledWith({ env: 'GITHUB_TOKEN' });
    expect(fieldError()).toBeUndefined();
  });

  it('shows an error for a lower-case env name and does not emit it', () => {
    const onChange = vi.fn();
    render({ onChange });
    type(input(), 'github_token');
    expect(onChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe('Use capitals, digits and underscores, e.g. GITHUB_TOKEN');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('emits { secret: name } in Studio-secret mode, clearing the value on the switch', () => {
    const onChange = vi.fn();
    render({ onChange });
    choose(select(), 'secret');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    type(input(), 'gh');
    expect(onChange).toHaveBeenLastCalledWith({ secret: 'gh' });
  });

  it('rejects a bad secret name and does not emit it', () => {
    const onChange = vi.fn();
    render({ onChange });
    choose(select(), 'secret');
    onChange.mockClear();
    type(input(), 'no spaces');
    expect(onChange).not.toHaveBeenCalled();
    expect(fieldError()).toBe('Use letters, digits, dot, dash or underscore');
  });

  it('offers plain text only with allowPlain, then emits a string and warns', () => {
    const onChange = vi.fn();
    render({ onChange, allowPlain: true });
    const options = [...select().querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['Environment variable', 'Studio secret', 'Plain text']);
    choose(select(), 'plain');
    type(input(), 'abc123');
    expect(onChange).toHaveBeenLastCalledWith('abc123');
    expect(container.querySelector('.field-warning')!.textContent).toBe(
      'Plain values are saved in the YAML file. Prefer a secret.',
    );
  });

  it('shows the existing value: env name, secret name or plain string', () => {
    render({ value: { secret: 'bot-token' } });
    expect(input().value).toBe('bot-token');
    expect(select().value).toBe('secret');
  });

  it('emits undefined when the input is cleared', () => {
    const onChange = vi.fn();
    render({ onChange, value: { env: 'X' } });
    type(input(), '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(fieldError()).toBeUndefined();
  });

  it('shows Required for an empty required field', () => {
    const onChange = vi.fn();
    render({ onChange, value: { env: 'X' }, required: true });
    type(input(), '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(fieldError()).toBe('Required');
  });
});
