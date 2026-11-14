/**
 * `RouterForm` — the `oneOf` step's Inspector body: one row per branch
 * (the target step's title read-only, its condition as a mono `Input`, a
 * "Default" tag while the condition is empty). Conditions live in
 * `children.options`, outside `data.step`, so edits go through
 * `setOptionCondition`, not `patch`. Two empty conditions is an error —
 * "Only one branch can be the default".
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import type { KindFieldsProps } from '../index';
import { flowNodeTitle } from './flowForm';
import './flow.css';

type FlowProps = KindFieldsProps<'flow'>;

/** The router's branch rows plus the default-branch rule. */
export function RouterForm({ node, graph, setOptionCondition }: FlowProps): JSX.Element {
  const children = node.data.children;
  const options = children.shape === 'options' ? children.options : [];
  const defaults = options.filter((o) => o.condition === undefined || o.condition.trim() === '').length;
  const base = `node-flow-${String(node.data.step.id)}`;

  return (
    <Field
      id={`${base}-branches`}
      label="Branches"
      error={defaults > 1 ? 'Only one branch can be the default' : undefined}
      hint="Expressions over flow variables, e.g. category == 'refund'. Leave one empty as the default."
    >
      <div className="kv-rows">
        {options.map((option, index) => {
          const condition = option.condition ?? '';
          const isDefault = condition.trim() === '';
          return (
            <div key={option.id} className="kv-row">
              <span className="flow-child-title" title={flowNodeTitle(graph, option.id)}>
                {flowNodeTitle(graph, option.id)}
              </span>
              <Input
                id={index === 0 ? `${base}-condition` : `${base}-condition-${index}`}
                className="mono"
                value={condition}
                placeholder={isDefault ? 'default' : 'condition'}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setOptionCondition?.(option.id, e.target.value)
                }
              />
              {isDefault ? <span className="flow-default-tag">Default</span> : <span />}
            </div>
          );
        })}
      </div>
    </Field>
  );
}
