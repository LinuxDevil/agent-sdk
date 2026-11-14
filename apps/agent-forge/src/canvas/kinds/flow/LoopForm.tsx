/**
 * `LoopForm` — the `forEach` step's Inspector body: Items (`$variable`
 * text, or a JSON list behind the "List of values" toggle), Item variable
 * and Index variable (identifier pattern, defaulting to `item`/`index`).
 */
import { useState, type ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { JsonField } from '../../fields/JsonField';
import type { KindFieldsProps } from '../index';
import { IDENTIFIER_PATTERN, type StepRecord } from './flowForm';
import './flow.css';

type FlowProps = KindFieldsProps<'flow'>;

/** `step.items` is a literal list when it is an array, else a `$var` string. */
function isListItems(value: unknown): boolean {
  return Array.isArray(value);
}

/** The Items control: mono text for a `$var`, JsonField rows for a literal list. */
function ItemsField({ id, step, patch }: { id: string; step: StepRecord; patch(p: Record<string, unknown>): void }): JSX.Element {
  const [list, setList] = useState(() => isListItems(step.items));
  const toggle = () => {
    setList(!list);
    patch({ items: undefined });
  };
  if (list) {
    return (
      <>
        <JsonField
          id={id}
          label="Items"
          value={step.items}
          rows={4}
          check={(v) => (Array.isArray(v) ? undefined : 'Use a JSON list of values')}
          help="A fixed list of values."
          onChange={(next) => patch({ items: next })}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggle}>
          Variable list
        </button>
      </>
    );
  }
  const items = typeof step.items === 'string' ? step.items : '';
  return (
    <Field
      id={id}
      label="Items"
      required={items === ''}
      error={items === '' ? 'Required' : undefined}
      hint="A $variable holding a list."
    >
      <div className="modelpicker-row">
        <Input
          className="mono"
          value={items}
          placeholder="$items"
          onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ items: e.target.value === '' ? undefined : e.target.value })}
        />
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggle}>
          List of values
        </button>
      </div>
    </Field>
  );
}

/** The `forEach` step's fields. */
export function LoopForm({ node, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const base = `node-flow-${String(step.id)}`;
  const varError = (field: string) => {
    const value = typeof step[field] === 'string' ? step[field] : '';
    return value !== '' && !IDENTIFIER_PATTERN.test(value) ? 'Use a variable name like order_id' : undefined;
  };
  const varInput = (field: string, label: string, fallback: string, index: number) => {
    const value = typeof step[field] === 'string' ? step[field] : '';
    return (
      <Field id={`${base}-${field}-${index}`} label={label} error={varError(field)} hint={`Default '${fallback}'.`}>
        <Input
          className="mono"
          value={value}
          placeholder={fallback}
          onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ [field]: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
    );
  };
  return (
    <>
      <ItemsField id={`${base}-items`} step={step} patch={patch} />
      {varInput('itemVariable', 'Item variable', 'item', 0)}
      {varInput('indexVariable', 'Index variable', 'index', 1)}
    </>
  );
}
