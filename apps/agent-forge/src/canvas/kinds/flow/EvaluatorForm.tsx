/**
 * `EvaluatorForm` — the `evaluator` step's Inspector body: the expression
 * (same grammar as router conditions) and the variable that receives the
 * result.
 */
import type { KindFieldsProps } from '../index';
import { OutputVariableField, StepInput } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** The `evaluator` step's fields. */
export function EvaluatorForm({ node, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const base = `node-flow-${String(step.id)}`;
  return (
    <>
      <StepInput
        id={`${base}-expression`}
        field="expression"
        step={step}
        patch={patch}
        label="Expression"
        required
        hint="Same grammar as router conditions."
      />
      <OutputVariableField id={`${base}-output`} step={step} patch={patch} />
    </>
  );
}
