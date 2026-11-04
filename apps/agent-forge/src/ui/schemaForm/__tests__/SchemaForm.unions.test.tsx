import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { render as mount } from '../../__tests__/render';
import { SchemaForm, type SchemaFormProps } from '../SchemaForm';
import type { JsonSchema } from '../types';

import { SPEC } from './fixture';

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

const render = (props: HarnessProps = {}, schema: JsonSchema = SPEC) => {
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

function pick(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const blur = (el: Element) => act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

const q = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;

const toolsField = () => q('[data-path="tools"]');
const toolsAdd = () => toolsField().querySelector<HTMLButtonElement>('.schema-list-add')!;

describe('SchemaForm unions and object arrays', () => {
  it('adds an expanded union item, picks a kind and edits its fields', () => {
    render();
    click(toolsAdd());
    const item = q('li.schema-item');
    expect(container.querySelectorAll('li.schema-item')).toHaveLength(1);
    expect(item.querySelector('.schema-item-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(item.querySelector('.schema-item-body')).not.toBeNull();

    const kind = q<HTMLSelectElement>('.schema-variant select');
    expect(kind.getAttribute('aria-label')).toBe('Item 1 kind');
    expect([...kind.options].map((o) => o.textContent)).toEqual([
      'Choose a kind…',
      'Builtin',
      'Registry',
      'File',
    ]);

    pick(kind, '0');
    const builtin = q<HTMLInputElement>('.schema-variant-body input#p-tools-0-builtin');
    type(builtin, 'http');
    expect(last).toEqual({ tools: [{ builtin: 'http' }] });
    expect(q('.schema-item-summary').textContent).toBe('http');
  });

  it('switching kind resets the value but keeps shared keys', () => {
    render({ initial: { tools: [{ builtin: 'http', id: 't1' }] } });
    pick(q<HTMLSelectElement>('.schema-variant select'), '2');
    expect(last).toEqual({ tools: [{ file: '', id: 't1' }] });
    expect(q<HTMLSelectElement>('.schema-variant select').value).toBe('2');
    expect(q<HTMLInputElement>('input#p-tools-0-id').value).toBe('t1');
  });

  it('moves an item down and focuses its Move up button', () => {
    render({ initial: { tools: [{ builtin: 'http' }, { file: 'run.ts' }] } });
    click(q('button[aria-label="Move http down"]'));
    expect(last).toEqual({ tools: [{ file: 'run.ts' }, { builtin: 'http' }] });
    const moved = q('li.schema-item[data-index="1"]');
    expect(moved.querySelector('.schema-item-summary')!.textContent).toBe('http');
    expect(document.activeElement).toBe(moved.querySelector('button[aria-label="Move http up"]'));
  });

  it('moves an item up and focuses its Move down button', () => {
    render({ initial: { tools: [{ builtin: 'http' }, { file: 'run.ts' }] } });
    click(q('button[aria-label="Move run.ts up"]'));
    expect(last).toEqual({ tools: [{ file: 'run.ts' }, { builtin: 'http' }] });
    const moved = q('li.schema-item[data-index="0"]');
    expect(document.activeElement).toBe(moved.querySelector('button[aria-label="Move run.ts down"]'));
  });

  it('removes an item and focuses the next item’s toggle', () => {
    render({ initial: { tools: [{ builtin: 'http' }, { file: 'run.ts' }] } });
    click(q('button[aria-label="Remove http"]'));
    expect(last).toEqual({ tools: [{ file: 'run.ts' }] });
    expect(container.querySelectorAll('li.schema-item')).toHaveLength(1);
    expect(document.activeElement).toBe(
      q('li.schema-item[data-index="0"]').querySelector('.schema-item-toggle'),
    );
  });

  it('focuses the Add button when the last item is removed', () => {
    render({ initial: { tools: [{ builtin: 'http' }] } });
    click(q('button[aria-label="Remove http"]'));
    expect(last).toEqual({});
    expect(document.activeElement).toBe(toolsAdd());
  });

  it('collapses an expanded item via its toggle', () => {
    render({ initial: { tools: [{ builtin: 'http' }] } });
    const toggle = q('.schema-item-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    click(toggle);
    expect(q('.schema-item-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.schema-item-body')).toBeNull();
  });
});

describe('SchemaForm record maps', () => {
  it('adds a record entry from the new-key row', () => {
    render();
    const field = q('[data-path="instructionsByFamily"]');
    const newKey = field.querySelector<HTMLInputElement>('input[aria-label="New Instructions by family key"]')!;
    type(newKey, 'claude');
    click(field.querySelector('.schema-record-add button')!);
    expect(last).toEqual({ instructionsByFamily: { claude: '' } });
    const keyInput = q<HTMLInputElement>('input[aria-label="Instructions by family key 1"]');
    expect(keyInput.value).toBe('claude');
  });

  it('refuses duplicate and empty keys with the exact messages and no commit', () => {
    render({ initial: { instructionsByFamily: { claude: 'x' } } });
    const field = q('[data-path="instructionsByFamily"]');
    const newKey = field.querySelector<HTMLInputElement>('input[aria-label="New Instructions by family key"]')!;
    const before = last;
    type(newKey, 'claude');
    click(field.querySelector('.schema-record-add button')!);
    expect(field.textContent).toContain('“claude” is already used.');
    expect(last).toBe(before);

    const keyInput = q<HTMLInputElement>('input[aria-label="Instructions by family key 1"]');
    type(keyInput, '');
    blur(keyInput);
    expect(field.textContent).toContain('Key can’t be empty.');
    expect(last).toBe(before);
  });

  it('renames a key on blur keeping the value and position, and edits the value', () => {
    render({ initial: { instructionsByFamily: { claude: 'x', openai: 'y' } } });
    const keyInput = q<HTMLInputElement>('input[aria-label="Instructions by family key 1"]');
    type(keyInput, 'anthropic');
    blur(keyInput);
    expect(last).toEqual({ instructionsByFamily: { anthropic: 'x', openai: 'y' } });
    expect(Object.keys((last as Record<string, Record<string, unknown>>).instructionsByFamily)).toEqual([
      'anthropic',
      'openai',
    ]);
    const value = q<HTMLInputElement>('input#p-instructionsByFamily-anthropic');
    type(value, 'sonnet rules');
    expect(last).toEqual({ instructionsByFamily: { anthropic: 'sonnet rules', openai: 'y' } });
  });

  it('removes a record entry', () => {
    render({ initial: { instructionsByFamily: { claude: 'x', openai: 'y' } } });
    click(q('button[aria-label="Remove claude"]'));
    expect(last).toEqual({ instructionsByFamily: { openai: 'y' } });
  });
});
