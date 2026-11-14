import type { ReactElement } from 'react';
import type { UiChoiceField, UiFileField, UiInputField, UiNumberField, UiOption, UiText } from '@linuxdevil/lousho/workspaces/client';
import type { RenderContext } from '../context';
import { enumValues, fieldSchema } from '../schema';
import { Field, FieldError, fieldLabel, useControl } from './field';

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

export function TextInput({ node, ctx }: { node: UiText; ctx: RenderContext }): ReactElement {
  const bind = node.bind ?? 'inputs';
  const control = useControl(ctx, bind);
  return (
    <Field id={control.id} label={fieldLabel(node.label, bind)} error={control.error}>
      <input className="lwr-input" type="text" {...control.aria} value={asText(control.value)} placeholder={node.placeholder} onChange={(event) => ctx.form.set(bind, event.target.value)} />
    </Field>
  );
}

export function TextArea({ node, ctx }: { node: UiInputField; ctx: RenderContext }): ReactElement {
  const control = useControl(ctx, node.bind);
  return (
    <Field id={control.id} label={fieldLabel(node.label, node.bind)} error={control.error}>
      <textarea className="lwr-input" {...control.aria} value={asText(control.value)} placeholder={node.placeholder} onChange={(event) => ctx.form.set(node.bind, event.target.value)} />
    </Field>
  );
}

const toNumber = (text: string): number | undefined => (text === '' ? undefined : Number(text));

export function NumberInput({ node, ctx }: { node: UiNumberField; ctx: RenderContext }): ReactElement {
  const control = useControl(ctx, node.bind);
  const value = typeof control.value === 'number' ? control.value : node.type === 'slider' ? (node.min ?? 0) : '';
  return (
    <Field id={control.id} label={fieldLabel(node.label, node.bind)} error={control.error}>
      <input
        className="lwr-input"
        type={node.type === 'slider' ? 'range' : 'number'}
        {...control.aria}
        min={node.min}
        max={node.max}
        step={node.step}
        value={value}
        onChange={(event) => ctx.form.set(node.bind, toNumber(event.target.value))}
      />
    </Field>
  );
}

export function Toggle({ node, ctx }: { node: UiInputField; ctx: RenderContext }): ReactElement {
  const control = useControl(ctx, node.bind);
  return (
    <Field id={control.id} label={fieldLabel(node.label, node.bind)} error={control.error}>
      <input className="lwr-toggle" type="checkbox" {...control.aria} checked={control.value === true} onChange={(event) => ctx.form.set(node.bind, event.target.checked)} />
    </Field>
  );
}

export function choiceOptions(node: UiChoiceField, ctx: RenderContext): UiOption[] {
  return node.options ?? enumValues(fieldSchema(ctx.inputsSchema, node.bind)).map((value) => ({ value: value as UiOption['value'] }));
}

const optionText = (option: UiOption): string => option.label ?? String(option.value);

export function ChoiceSelect({ node, ctx }: { node: UiChoiceField; ctx: RenderContext }): ReactElement {
  const control = useControl(ctx, node.bind);
  const options = choiceOptions(node, ctx);
  const at = options.findIndex((option) => option.value === control.value);
  return (
    <Field id={control.id} label={fieldLabel(node.label, node.bind)} error={control.error}>
      <select className="lwr-input" {...control.aria} value={at >= 0 ? String(at) : ''} onChange={(event) => ctx.form.set(node.bind, options[Number(event.target.value)]?.value)}>
        <option value="" disabled>
          Choose
        </option>
        {options.map((option, index) => (
          <option key={index} value={String(index)}>
            {optionText(option)}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ChoiceRadio({ node, ctx }: { node: UiChoiceField; ctx: RenderContext }): ReactElement {
  const control = useControl(ctx, node.bind);
  const options = choiceOptions(node, ctx);
  return (
    <fieldset className="lwr-field" aria-describedby={control.aria['aria-describedby']}>
      <legend className="lwr-label">{fieldLabel(node.label, node.bind)}</legend>
      {options.map((option, index) => (
        <label key={index} className="lwr-choice">
          <input type="radio" name={control.id} checked={option.value === control.value} onChange={() => ctx.form.set(node.bind, option.value)} />
          {optionText(option)}
        </label>
      ))}
      <FieldError id={control.id} error={control.error} />
    </fieldset>
  );
}

export function FileInput({ node }: { node: UiFileField; ctx: RenderContext }): ReactElement {
  return <p className="lwr-note">{fieldLabel(node.label, node.bind)}: file upload is not available yet</p>;
}

export function SchemaFormField({ node }: { node: UiInputField; ctx: RenderContext }): ReactElement {
  return <p className="lwr-note">{fieldLabel(node.label, node.bind)}: this form is not available yet</p>;
}
