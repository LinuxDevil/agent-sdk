import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { KeyValueField, type KeyValueFieldProps } from '../KeyValueField';

let container: HTMLDivElement;
const render = (props: Partial<KeyValueFieldProps> = {}) => {
  container = mount(
    <KeyValueField id="node-mcp-env" label="Environment" value={undefined} onChange={vi.fn()} valueKind="text" {...props} />,
  );
};

const rows = () => [...container.querySelectorAll('.kv-row')];
const rowInputs = (row: Element) => row.querySelectorAll('input');
const addButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add')!;
const fieldError = () => container.querySelector('.field-error')?.textContent ?? undefined;

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (el: Element) => act(() => (el as HTMLElement).click());

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('KeyValueField', () => {
  it('appends a { "": "" } row on Add', () => {
    const onChange = vi.fn();
    render({ onChange });
    click(addButton());
    expect(rows()).toHaveLength(1);
    expect(onChange).toHaveBeenLastCalledWith({ '': '' });
  });

  it('emits entries in insertion order', () => {
    const onChange = vi.fn();
    render({ onChange });
    click(addButton());
    type(rowInputs(rows()[0])[0], 'beta');
    type(rowInputs(rows()[0])[1], '1');
    click(addButton());
    type(rowInputs(rows()[1])[0], 'alpha');
    expect(onChange).toHaveBeenLastCalledWith({ beta: '1', alpha: '' });
    const last = onChange.mock.lastCall![0] as Record<string, string>;
    expect(Object.keys(last)).toEqual(['beta', 'alpha']);
  });

  it('flags duplicate keys and does not emit them', () => {
    const onChange = vi.fn();
    render({ onChange });
    click(addButton());
    click(addButton());
    type(rowInputs(rows()[0])[0], 'a');
    const calls = onChange.mock.calls.length;
    type(rowInputs(rows()[1])[0], 'a');
    expect(fieldError()).toBe('Each name must be unique');
    expect(onChange.mock.calls.length).toBe(calls);
    // Fixing the duplicate emits again and clears the error.
    type(rowInputs(rows()[1])[0], 'b');
    expect(fieldError()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith({ a: '', b: '' });
  });

  it('enforces keyPattern on non-empty keys', () => {
    const onChange = vi.fn();
    render({ onChange, keyPattern: /^[A-Z_][A-Z0-9_]*$/ });
    click(addButton());
    type(rowInputs(rows()[0])[0], 'lower');
    expect(fieldError()).toBe('Use capitals, digits and underscores');
    expect(onChange).not.toHaveBeenLastCalledWith(expect.objectContaining({ lower: '' }));
  });

  it('edits secret values through a SecretRefField', () => {
    const onChange = vi.fn();
    render({ onChange, valueKind: 'secret' });
    click(addButton());
    const row = rows()[0];
    type(rowInputs(row)[0], 'TOKEN');
    // The blank row's '' value shows the plain kind; pick Environment variable first.
    choose(row.querySelector('select')!, 'env');
    const secretInput = row.querySelector('.secretref-row input')!;
    type(secretInput as HTMLInputElement, 'GITHUB_TOKEN');
    expect(onChange).toHaveBeenLastCalledWith({ TOKEN: { env: 'GITHUB_TOKEN' } });
  });

  it('removes a row and emits undefined for the last one', () => {
    const onChange = vi.fn();
    render({ onChange, value: { a: '1', b: '2' } });
    click(container.querySelector('button[aria-label="Remove a"]')!);
    expect(onChange).toHaveBeenLastCalledWith({ b: '2' });
    click(container.querySelector('button[aria-label="Remove b"]')!);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
