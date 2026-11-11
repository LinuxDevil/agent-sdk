/**
 * `FlowStepFields` — the `flow` kind's Inspector body (C25). Every known
 * step `type` gets its form through `STEP_FORMS`; the shared "Step id"
 * field, the "Run options" section (executable steps and containers) and,
 * on the root step only, "Flow settings" wrap them. Unknown/editor-only
 * types keep the C15 generic JSON view of `data.step`.
 */
import type { ChangeEvent } from 'react';
import { InspectorSection } from '../../../components/InspectorSection';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { GenericFields } from '../GenericFields';
import type { KindFieldsProps } from '../index';
import { EXECUTABLE_TYPES } from '../../../graph/v2/specTypes';
import { stepIdError, type StepRecord } from './flowForm';
import { RunOptionsSection } from './RunOptionsSection';
import { RouterForm } from './RouterForm';
import { LoopForm } from './LoopForm';
import { EvaluatorForm } from './EvaluatorForm';
import { LlmCallForm } from './LlmCallForm';
import { ToolCallForm } from './ToolCallForm';
import { AgentStepForm } from './AgentStepForm';
import { ApprovalStepForm } from './ApprovalStepForm';
import { SetVariableForm } from './SetVariableForm';
import { EndForm } from './EndForm';
import { ThrowForm } from './ThrowForm';
import { ContainerForm } from './ContainerForm';
import { FlowMetaSection } from './FlowMetaSection';
import './flow.css';

type FlowProps = KindFieldsProps<'flow'>;

const RUNNABLE: ReadonlySet<string> = new Set(EXECUTABLE_TYPES);

/** The per-type form bodies; `sequence`/`parallel` share the container list. */
const STEP_FORMS: Record<string, (props: FlowProps) => JSX.Element> = {
  sequence: ContainerForm,
  parallel: ContainerForm,
  oneOf: RouterForm,
  forEach: LoopForm,
  evaluator: EvaluatorForm,
  llmCall: LlmCallForm,
  agent: AgentStepForm,
  approval: ApprovalStepForm,
  toolCall: ToolCallForm,
  setVariable: SetVariableForm,
  end: EndForm,
  return: EndForm,
  throw: ThrowForm,
};

/** The shared "Step id" field every flow node shows. */
function StepIdField({ node, graph, patch }: FlowProps): JSX.Element {
  const step = node.data.step;
  const stepId = String(step.id);
  return (
    <Field
      id={`node-flow-${stepId}-id`}
      label="Step id"
      required
      error={stepIdError(stepId, graph, node.id)}
      hint="Used in traces and checkpoints."
    >
      <StepIdInput step={step} patch={patch} />
    </Field>
  );
}

/** The step-id `Input`. */
function StepIdInput({ step, patch }: { step: StepRecord; patch(p: Record<string, unknown>): void }): JSX.Element {
  return (
    <Input
      className="mono"
      value={String(step.id)}
      onChange={(e: ChangeEvent<HTMLInputElement>) => patch({ id: e.target.value })}
    />
  );
}

/** The `flow` kind's Inspector body. */
export function FlowStepFields(props: FlowProps): JSX.Element {
  const { node } = props;
  const type = String(node.data.step.type);
  const Form = STEP_FORMS[type];

  // Unknown/editor-only step types keep the C15 JSON view of `data.step`.
  if (Form === undefined) {
    return (
      <>
        <StepIdField {...props} />
        <GenericFields {...props} />
      </>
    );
  }

  return (
    <>
      <InspectorSection id="flow-step" title="Step">
        <StepIdField {...props} />
        <Form {...props} />
      </InspectorSection>
      {(RUNNABLE.has(type) || type === 'sequence' || type === 'parallel') && <RunOptionsSection {...props} />}
      {node.data.flowMeta !== undefined && <FlowMetaSection {...props} />}
    </>
  );
}
