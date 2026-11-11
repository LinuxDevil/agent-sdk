/**
 * Shared helpers for the `flow` kind's Inspector forms (C25): the field
 * patterns the spec enforces, root-step detection, step/child titles for
 * the container and router lists, and the `patch`-oriented writers every
 * per-type form shares (`step.<field>` through `patchNode`'s `step` slot,
 * `flowMeta.<field>` through `patchFlowMeta`).
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Textarea } from '../../../ui/controls';
import type { FlowNodeData, Graph, NodeOfKind } from '../../../graph/v2/types';
import { STEP_VIEWS } from './stepViews';

/** Step `id` values: `^[A-Za-z0-9_-]{1,64}$` (used in traces and checkpoints). */
const STEP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Variable names (`variable`, `outputVariable`, `itemVariable`, …). */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `flowMeta.code`: `^[a-z0-9][a-z0-9-]{0,63}$`. */
export const FLOW_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The step record a flow node's form edits (`data.step`). */
export type StepRecord = NodeOfKind<'flow'>['data']['step'];

/** The display title of a flow node for child lists: its step-type label plus the step id. */
export function flowNodeTitle(graph: Graph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined || node.kind !== 'flow') return nodeId;
  const data = node.data as FlowNodeData;
  const type = String(data.step.type);
  const label = STEP_VIEWS[type]?.label ?? (type === '' ? 'Step' : type);
  return `${label} · ${String(data.step.id)}`;
}

/** The live flow nodes' step ids, `exceptNodeId` excluded (proposed removals skipped). */
function usedStepIds(graph: Graph, exceptNodeId?: string): string[] {
  return graph.nodes
    .filter((n): n is NodeOfKind<'flow'> => n.kind === 'flow' && n.proposed !== 'remove' && n.id !== exceptNodeId)
    .map((n) => String(n.data.step.id));
}

/** `step.id`'s inline error: pattern first, then uniqueness among the other live steps. */
export function stepIdError(stepId: string, graph: Graph, nodeId: string): string | undefined {
  if (!STEP_ID_PATTERN.test(stepId)) return 'Use letters, digits, dash or underscore (up to 64)';
  if (usedStepIds(graph, nodeId).includes(stepId)) return 'Another step already uses this id';
  return undefined;
}

/** A `Field`-wrapped mono `Input` bound to `step[field]`; empty text deletes the key. */
export function StepInput({
  id,
  field,
  step,
  patch,
  label = field,
  required = false,
  error,
  hint,
  placeholder,
}: {
  id: string;
  field: string;
  step: StepRecord;
  patch(patch: Record<string, unknown>): void;
  label?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  placeholder?: string;
}): JSX.Element {
  const value = step[field];
  return (
    <Field id={id} label={label} required={required} error={error} hint={hint}>
      <Input
        className="mono"
        value={typeof value === 'string' ? value : ''}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          patch({ [field]: e.target.value === '' ? undefined : e.target.value })
        }
      />
    </Field>
  );
}

/** The `outputVariable` row shared by the step types that save a result (`evaluator`, `llmCall`, `toolCall`, `agent`). */
export function OutputVariableField({
  id,
  step,
  patch,
}: {
  id: string;
  step: StepRecord;
  patch(patch: Record<string, unknown>): void;
}): JSX.Element {
  const value = typeof step.outputVariable === 'string' ? step.outputVariable : '';
  return (
    <Field
      id={id}
      label="Save result as"
      error={value !== '' && !IDENTIFIER_PATTERN.test(value) ? 'Use a variable name like order_id' : undefined}
      hint="Read it later as {{name}}."
    >
      <Input
        className="mono"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          patch({ outputVariable: e.target.value === '' ? undefined : e.target.value })
        }
      />
    </Field>
  );
}

/** A `Field`-wrapped mono `Textarea` bound to `step[field]`; empty text deletes the key. */
export function StepTextarea({
  id,
  field,
  step,
  patch,
  label = field,
  required = false,
  error,
  hint,
  rows = 3,
}: {
  id: string;
  field: string;
  step: StepRecord;
  patch(patch: Record<string, unknown>): void;
  label?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  rows?: number;
}): JSX.Element {
  const value = step[field];
  return (
    <Field id={id} label={label} required={required} error={error} hint={hint}>
      <Textarea
        rows={rows}
        value={typeof value === 'string' ? value : ''}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
          patch({ [field]: e.target.value === '' ? undefined : e.target.value })
        }
      />
    </Field>
  );
}
