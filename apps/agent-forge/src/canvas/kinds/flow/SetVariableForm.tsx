/**
 * `SetVariableForm` — the `setVariable` step's Inspector body: the
 * variable name (identifier pattern, required) and its value (text with
 * `$name` variable reads, or JSON behind the shared toggle).
 */
import type { ChangeEvent } from 'react';
import type { KindFieldsProps } from '../index';
import { IDENTIFIER_PATTERN } from './flowForm';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { ValueField } from './ValueField';

type FlowProps = KindFieldsProps<'flow'>;

/** The `setVariable` step's fields. */
export function SetVariableForm({ node, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const base = `node-flow-${String(step.id)}`;
  const variable = typeof step.variable === 'string' ? step.variable : '';
  return (
    <>
      <Field
        id={`${base}-variable`}
        label="Variable"
        required={variable === ''}
        error={
          variable === ''
            ? 'Required'
            : IDENTIFIER_PATTERN.test(variable)
              ? undefined
              : 'Use a variable name like order_id'
        }
      >
        <Input
          className="mono"
          value={variable}
          onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ variable: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
      <ValueField id={`${base}-value`} step={step} patch={patch} label="Value" help="Start with $ to copy another variable." />
    </>
  );
}
