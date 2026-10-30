import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render as mount } from './render';

import { Field } from '../Field';
import { Checkbox, Input, Select, Switch, Textarea } from '../controls';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

const click = (el: Element) => act(() => (el as HTMLElement).click());
const noop = () => {};

describe('Field', () => {
  it('labels, describes, invalidates and requires the control it wraps', () => {
    render(
      <Field label="Name" hint="Shown on the card." error="Required." required>
        <Input value="" onChange={noop} />
      </Field>,
    );
    const input = container.querySelector('input')!;
    const label = container.querySelector('label.field-label')!;
    expect(label.getAttribute('for')).toBe(input.id);

    const describedBy = input.getAttribute('aria-describedby')!.split(' ');
    expect(describedBy).toHaveLength(2);
    const [hintId, errorId] = describedBy;
    expect(document.getElementById(hintId)!.textContent).toBe('Shown on the card.');
    expect(document.getElementById(errorId)!.textContent).toBe('Required.');
    expect(document.getElementById(errorId)!.className).toBe('hint field-error');

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');

    const required = container.querySelector('.field-required')!;
    expect(required.textContent).toBe('*');
    expect(required.getAttribute('aria-hidden')).toBe('true');

    expect(container.firstElementChild!.classList.contains('field-invalid')).toBe(true);
  });

  it('lets an explicit id and aria-describedby on the control win over the Field defaults', () => {
    render(
      <Field label="Name" hint="Shown on the card." error="Required.">
        <Input id="x" aria-describedby="mine" value="" onChange={noop} />
      </Field>,
    );
    const input = container.querySelector('input')!;
    expect(input.id).toBe('x');
    expect(input.getAttribute('aria-describedby')).toBe('mine');
  });

  it('names a Switch inside an inline Field through the label, no aria-label needed', () => {
    render(
      <Field label="Enable support-bot" inline>
        <Switch checked onChange={noop} />
      </Field>,
    );
    const field = container.querySelector('.field.field-inline')!;
    const label = field.querySelector('label.field-label')!;
    const button = field.querySelector('button[role="switch"]')!;
    expect(button.id).toBeTruthy();
    expect(button.id).toBe(label.getAttribute('for'));
    expect(button.getAttribute('aria-label')).toBeNull();
  });
});

describe('Select', () => {
  it('renders a disabled placeholder option first, keeps option order and supports controlSize="sm"', () => {
    render(
      <Select
        value=""
        onChange={noop}
        placeholder="Pick a model"
        controlSize="sm"
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta', disabled: true },
        ]}
      />,
    );
    const select = container.querySelector('select')!;
    const options = [...select.querySelectorAll('option')];
    expect(options[0].value).toBe('');
    expect(options[0].disabled).toBe(true);
    expect(options[0].textContent).toBe('Pick a model');
    expect(options.slice(1).map((o) => o.textContent)).toEqual(['Alpha', 'Beta']);
    expect(options[2].disabled).toBe(true);
    expect(select.value).toBe('');
    expect(select.classList.contains('select-sm')).toBe(true);
  });
});

describe('Textarea', () => {
  it('is mono by default and picks up prose/autoGrow classes when asked', () => {
    render(<Textarea defaultValue="" />);
    expect(container.querySelector('textarea')!.className).toBe('textarea');

    render(<Textarea prose autoGrow defaultValue="" />);
    expect(container.querySelector('textarea')!.className).toBe('textarea textarea-prose textarea-autogrow');
  });
});

describe('Switch', () => {
  it('is a button[role=switch] that toggles on click and does nothing when disabled', () => {
    const spy = vi.fn();
    render(<Switch checked={false} label="Enable support-bot" onChange={spy} />);
    const button = container.querySelector('button[role="switch"]')!;
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Enable support-bot');
    click(button);
    expect(spy).toHaveBeenCalledWith(true);

    const disabledSpy = vi.fn();
    render(<Switch checked={false} label="Enable support-bot" onChange={disabledSpy} disabled />);
    click(container.querySelector('button[role="switch"]')!);
    expect(disabledSpy).not.toHaveBeenCalled();
  });

  it('draws an aria-hidden On/Off state label and a switch-sm size class', () => {
    render(<Switch checked={false} label="Enable support-bot" onChange={noop} stateLabel size="sm" />);
    const state = container.querySelector('.switch-state')!;
    expect(state.classList.contains('overline')).toBe(true);
    expect(state.textContent).toBe('Off');
    expect(state.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.switch')!.classList.contains('switch-sm')).toBe(true);

    render(<Switch checked label="Enable support-bot" onChange={noop} stateLabel />);
    expect(container.querySelector('.switch-state')!.textContent).toBe('On');
  });
});

describe('Checkbox', () => {
  it('sets the indeterminate property and toggles when its label is clicked', () => {
    const spy = vi.fn();
    render(<Checkbox label="Overwrite" checked={false} indeterminate onChange={spy} />);
    const input = container.querySelector('input')! as HTMLInputElement;
    expect(input.type).toBe('checkbox');
    expect(input.indeterminate).toBe(true);
    click(container.querySelector('label.checkbox-row')!);
    expect(spy).toHaveBeenCalled();
  });

  it('renders a muted description line and marks a disabled row', () => {
    render(<Checkbox label="Overwrite" description="Existing files are replaced." disabled onChange={noop} />);
    expect(container.querySelector('.checkbox-description')!.textContent).toBe('Existing files are replaced.');
    expect(container.querySelector('.checkbox-row')!.classList.contains('checkbox-row-disabled')).toBe(true);
    expect((container.querySelector('input')! as HTMLInputElement).disabled).toBe(true);
  });
});
