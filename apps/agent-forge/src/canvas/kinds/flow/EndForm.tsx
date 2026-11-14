/**
 * `EndForm` — the `end`/`return` step's Inspector body: the value the flow
 * finishes with (text `$var` read or JSON).
 */
import type { KindFieldsProps } from '../index';
import { ValueField } from './ValueField';

type FlowProps = KindFieldsProps<'flow'>;

/** The `end`/`return` step's fields (shared shape). */
export function EndForm({ node, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  return <ValueField id={`node-flow-${String(step.id)}-value`} step={step} patch={patch} label="Value" help="What the flow returns." />;
}
