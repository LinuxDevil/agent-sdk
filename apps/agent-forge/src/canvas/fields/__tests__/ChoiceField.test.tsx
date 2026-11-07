import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from '../../../ui/__tests__/render';

import { ChoiceField, type ChoiceFieldProps } from '../ChoiceField';

type Level = 'low' | 'medium' | 'high';
const OPTIONS: { value: Level; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

let container: HTMLDivElement;
const render = (props: Partial<ChoiceFieldProps<Level>> = {}) => {
  container = mount(
    <ChoiceField<Level> id="node-agent-reasoning" label="Reasoning" value="medium" options={OPTIONS} onChange={vi.fn()} {...props} />,
  );
};

const select = () => container.querySelector('select')!;
const optionLabels = () => [...select().querySelectorAll('option')].map((o) => o.textContent);

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('ChoiceField', () => {
  it('emits the chosen option value', () => {
    const onChange = vi.fn();
    render({ onChange });
    expect(optionLabels()).toEqual(['Low', 'Medium', 'High']);
    expect(select().value).toBe('2');
    choose(select(), '3');
    expect(onChange).toHaveBeenLastCalledWith('high');
  });

  it('offers an unset option with allowUnset that emits undefined', () => {
    const onChange = vi.fn();
    render({ onChange, allowUnset: true });
    expect(optionLabels()).toEqual(['Default', 'Low', 'Medium', 'High']);
    choose(select(), '0');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('uses unsetLabel and selects it while the value is undefined', () => {
    render({ allowUnset: true, unsetLabel: 'Provider default', value: undefined });
    expect(optionLabels()[0]).toBe('Provider default');
    expect(select().value).toBe('0');
  });
});
