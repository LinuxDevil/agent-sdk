/**
 * `ApprovalStepForm` — the `approval` step's Inspector body (S21 field):
 * the message the approver sees.
 */
import type { KindFieldsProps } from '../index';
import { StepTextarea } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** The `approval` step's fields. */
export function ApprovalStepForm({ node, patch }: FlowProps): JSX.Element {
  const message = node.data.step.message;
  const empty = typeof message !== 'string' || message === '';
  return (
    <StepTextarea
      id={`node-flow-${String(node.data.step.id)}-message`}
      field="message"
      step={node.data.step}
      patch={patch}
      label="Message"
      required={empty}
      error={empty ? 'Required' : undefined}
      hint="Shown to the person who approves."
    />
  );
}
