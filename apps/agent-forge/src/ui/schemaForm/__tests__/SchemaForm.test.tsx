import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { render as mount } from '../../__tests__/render';
import { SchemaForm, type SchemaFormProps } from '../SchemaForm';
import type { JsonSchema } from '../types';

import { SCHEMA } from './fixture';

let container: HTMLDivElement;
let last: unknown;

type HarnessProps = Partial<Omit<SchemaFormProps, 'value' | 'onChange' | 'idPrefix' | 'schema'>> & {
  initial?: unknown;
};

/** Stateful host: feeds every onChange value back into `value` and records it in `last`. */
function Harness({ schema, initial = {}, ...rest }: HarnessProps & { schema: JsonSchema }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <SchemaForm
      {...rest}
      schema={schema}
      idPrefix="p"
      value={value}
      onChange={(next) => {
        last = next;
        setValue(next);
      }}
    />
  );
}

const render = (props: HarnessProps = {}, schema: JsonSchema = SCHEMA) => {
  last = undefined;
  container = mount(<Harness {...props} schema={schema} />);
};

const click = (el: Element) => act(() => (el as HTMLElement).click());

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const blur = (el: Element) => act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

const q = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;

describe('SchemaForm', () => {
  it('renders the right control per kind with labels, hints and defaults', () => {
    render();
    expect(container.firstElementChild!.className).toBe('schema-form');

    const name = q<HTMLInputElement>('input#p-name');
    expect(name.type).toBe('text');
    expect(q('[data-path="name"] .field-label').textContent).toContain('Name');
    expect(q('[data-path="name"] .field-required').textContent).toBe('*');
    expect(document.getElementById('p-name-hint')!.textContent).toBe('Shown on the card.');

    expect(q('[data-path="model"] .field-label').textContent).toContain('Model');
    expect(q('[data-path="model"] .field-required').textContent).toBe('*');
    expect(container.querySelector('[data-path="reasoning"] .field-required')).toBeNull();

    const reasoning = q<HTMLSelectElement>('select#p-reasoning');
    expect(reasoning.options).toHaveLength(5);
    expect(reasoning.options[0].textContent).toBe('Choose…');
    expect([...reasoning.options].slice(1).map((o) => o.textContent)).toEqual([
      'Off',
      'Low',
      'Medium',
      'High',
    ]);

    const maxSteps = q<HTMLInputElement>('input#p-maxSteps');
    expect(maxSteps.type).toBe('number');
    expect(maxSteps.min).toBe('1');
    expect(maxSteps.max).toBe('100');
    expect(maxSteps.placeholder).toBe('Default: 12');

    const askQuestion = q('button[role="switch"]');
    expect(q('[data-path="askQuestion"]').contains(askQuestion)).toBe(true);

    const fieldset = q('fieldset.schema-object');
    expect(fieldset.getAttribute('data-path')).toBe('modelSettings');
    expect(fieldset.querySelector('legend.schema-legend')!.textContent).toBe('Model settings');
    expect(fieldset.querySelector('input#p-modelSettings-temperature')).not.toBeNull();

    expect(q('textarea#p-output')).not.toBeNull();
  });

  it('calls onChange with the whole value updated immutably; clearing removes the key', () => {
    const first = { name: 'x', model: 'm' };
    render({ initial: first });
    const name = q<HTMLInputElement>('input#p-name');
    type(name, 'Bot');
    expect(last).toEqual({ ...first, name: 'Bot' });
    expect(first.name).toBe('x');
    type(name, '');
    expect(last).toEqual({ model: 'm' });
  });

  it('commits numbers as numbers', () => {
    render({ initial: { name: 'x', model: 'm' } });
    type(q<HTMLInputElement>('input#p-maxSteps'), '7');
    expect(last).toEqual({ name: 'x', model: 'm', maxSteps: 7 });
  });

  it('adds, edits and removes primitive list rows', () => {
    render({ initial: { name: 'x', model: 'm' } });
    click(q('.schema-list-add'));
    const row = q<HTMLInputElement>('.schema-list-row input');
    expect(row.getAttribute('aria-label')).toBe('Fallback models 1');
    type(row, 'openai/gpt-5');
    expect(last).toEqual({ name: 'x', model: 'm', fallbackModels: ['openai/gpt-5'] });
    click(q('button[aria-label="Remove Fallback models 1"]'));
    expect(last).toEqual({ name: 'x', model: 'm' });
    expect(container.querySelectorAll('.schema-list-row')).toHaveLength(0);
  });

  it('keeps invalid JSON text, shows the parse error and commits on a valid blur', () => {
    render({ initial: { name: 'x', model: 'm' } });
    const output = q<HTMLTextAreaElement>('textarea#p-output');
    type(output, '{"a":');
    blur(output);
    expect(q('[data-path="output"] .field-error').textContent).toContain('Not valid JSON:');
    expect(last).toBeUndefined();

    type(output, '{"a":1}');
    blur(output);
    expect(last).toEqual({ name: 'x', model: 'm', output: { a: 1 } });
  });

  it('shows errors under the matching field and marks the control invalid', () => {
    render({ errors: { name: 'Required.' } });
    const name = q<HTMLInputElement>('input#p-name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(q('[data-path="name"] .field-error').textContent).toBe('Required.');
  });

  it('disables every control and hides list buttons when readOnly', () => {
    render({ readOnly: true, initial: { fallbackModels: ['a'] } });
    const controls = container.querySelectorAll('input, select, textarea, button[role="switch"]');
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach((el) => expect((el as HTMLInputElement).disabled).toBe(true));
    expect(container.querySelector('.schema-list-add')).toBeNull();
    expect(container.querySelector('[aria-label^="Remove"]')).toBeNull();
  });

  it('skips hiddenKeys', () => {
    render({ hiddenKeys: ['output'] });
    expect(container.querySelector('[data-path="output"]')).toBeNull();
    expect(q('[data-path="name"]')).not.toBeNull();
  });

  it('prefers labels and hints overrides over schema title/description', () => {
    render({ labels: { name: 'Bot name' }, hints: { name: 'Custom hint.' } });
    expect(q('[data-path="name"] .field-label').textContent).toContain('Bot name');
    expect(document.getElementById('p-name-hint')!.textContent).toBe('Custom hint.');
  });
});
