import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render, rerender } from '../../../ui/__tests__/render';
import { OutputFieldTable } from '../output/OutputFieldTable';

const SCHEMA = {
  type: 'object',
  properties: {
    priority: { type: 'string', enum: ['low', 'urgent'], description: 'How soon' },
    summary: { type: 'string' },
    count: { type: ['integer', 'null'] },
  },
  required: ['priority', 'summary'],
  additionalProperties: false,
};

function mount(jsonSchema: Record<string, unknown> = SCHEMA) {
  const onChange = vi.fn();
  const container = render(<OutputFieldTable jsonSchema={jsonSchema} onChange={onChange} />);
  return { container, onChange };
}

function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function fieldInput(container: HTMLElement, label: string): HTMLInputElement {
  return container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
}

function fieldSelect(container: HTMLElement, label: string): HTMLSelectElement {
  return container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function key(el: Element, keyName: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

function blur(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('OutputFieldTable rows', () => {
  it('renders one editable row per single-type property and a read-only row for a type list', () => {
    const { container } = mount();
    const names = [...container.querySelectorAll('.output-field-name')].map((el) => (el as HTMLInputElement).value);
    expect(names).toEqual(['priority', 'summary']);
    // `count` has a type list the table cannot show: read-only with the JSON hint.
    const readOnly = container.querySelector('.output-field-readonly')!;
    expect(readOnly.textContent).toContain('count');
    expect(readOnly.textContent).toContain('integer | null');
    expect(readOnly.textContent).toContain('Edit this field in the JSON below.');
    expect(readOnly.querySelector('input, select')).toBeNull();
  });

  it('adds a required string field_<n> on Add field', () => {
    const { container, onChange } = mount();
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Add field'))!);
    const emitted = onChange.mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.properties).toMatchObject({ field_1: { type: 'string' } });
    expect(emitted.required).toEqual(['priority', 'summary', 'field_1']);
    // Other schema keys pass through untouched.
    expect(emitted.type).toBe('object');
    expect(emitted.additionalProperties).toBe(false);
  });
});

describe('OutputFieldTable edits', () => {
  it('renames a field on blur, keeping property order and syncing required', () => {
    const { container, onChange } = mount();
    const input = fieldInput(container, 'Field priority name');
    act(() => setValue(input, 'severity'));
    blur(input);
    const emitted = onChange.mock.calls[0][0] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(emitted.properties)).toEqual(['severity', 'summary', 'count']);
    expect(emitted.properties.severity).toEqual({
      type: 'string',
      enum: ['low', 'urgent'],
      description: 'How soon',
    });
    expect(emitted.required).toEqual(['severity', 'summary']);
  });

  it('refuses a rename to a taken or malformed name', () => {
    const { container, onChange } = mount();
    const input = fieldInput(container, 'Field priority name');
    act(() => setValue(input, 'summary'));
    blur(input);
    expect(container.textContent).toContain('Another field uses this name');
    act(() => setValue(input, '1bad'));
    blur(input);
    expect(container.textContent).toContain('Use letters, digits and underscores');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a rename on Enter', () => {
    const { container, onChange } = mount();
    const input = fieldInput(container, 'Field summary name');
    act(() => setValue(input, 'note'));
    key(input, 'Enter');
    const emitted = onChange.mock.calls[0][0] as { properties: Record<string, unknown> };
    expect(Object.keys(emitted.properties)).toEqual(['priority', 'note', 'count']);
  });

  it('changes a field type, dropping other keywords but keeping the description', () => {
    const { container, onChange } = mount();
    const select = fieldSelect(container, 'Field priority type');
    act(() => {
      select.value = 'number';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const emitted = onChange.mock.calls[0][0] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(emitted.properties.priority).toEqual({ type: 'number', description: 'How soon' });
    expect(emitted.required).toEqual(['priority', 'summary']);
  });

  it('toggles required off and on', () => {
    const { container, onChange } = mount();
    // The Required checkbox sits in the summary row (priority is required, summary too).
    const requiredBoxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(requiredBoxes).toHaveLength(2);
    act(() => {
      requiredBoxes[1].click();
    });
    const emitted = onChange.mock.calls[0][0] as { required: string[] };
    expect(emitted.required).toEqual(['priority']);
  });

  it('edits and clears a description', () => {
    const { container, onChange } = mount();
    const input = fieldInput(container, 'Field summary description');
    act(() => setValue(input, 'One sentence'));
    const first = onChange.mock.calls[0][0] as { properties: Record<string, { description?: string }> };
    expect(first.properties.summary.description).toBe('One sentence');
    // The table is controlled: feed the emitted schema back so the input shows the new value.
    act(() =>
      rerender(<OutputFieldTable jsonSchema={first as Record<string, unknown>} onChange={onChange} />),
    );
    act(() => setValue(fieldInput(container, 'Field summary description'), ''));
    const emitted = onChange.mock.calls[1][0] as { properties: Record<string, Record<string, unknown>> };
    expect('description' in emitted.properties.summary).toBe(false);
  });

  it('removes a field and its required entry', () => {
    const { container, onChange } = mount();
    const remove = container.querySelector('button[aria-label="Remove field summary"]')!;
    click(remove);
    const emitted = onChange.mock.calls[0][0] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(emitted.properties)).toEqual(['priority', 'count']);
    expect(emitted.required).toEqual(['priority']);
  });
});
