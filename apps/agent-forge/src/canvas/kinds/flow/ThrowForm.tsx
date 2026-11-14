/**
 * `ThrowForm` — the `throw` step's Inspector body: the failure message
 * (`{{var}}` placeholders are replaced at run time).
 */
import type { KindFieldsProps } from '../index';
import { StepInput } from './flowForm';

type FlowProps = KindFieldsProps<'flow'>;

/** The `throw` step's fields. */
export function ThrowForm({ node, patch }: FlowProps): JSX.Element {
  return (
    <StepInput
      id={`node-flow-${String(node.data.step.id)}-message`}
      field="message"
      step={node.data.step}
      patch={patch}
      label="Message"
      hint="Use {{variable}}."
    />
  );
}
