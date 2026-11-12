import { SdkAttr } from '../../execution/semconv';
import { ValidationError } from '../../execution/errors';
import { WORK_TYPE_STEP_KINDS, type PageRunLabels, type PageStepLabels, type StepKind } from '../contracts/execution';

/** What an engine hands {@link labelsFor}: the run labels plus the step's own. */
export interface StepLabelInput extends PageRunLabels {
  /** Attachment alias from `agents.json` that runs the step. */
  attachment: string;
  /** What kind of step this is. */
  stepKind: StepKind;
  /** The step's position in one sequence across the run, from 0. */
  stepIndex: number;
  /** The `stepIndex` of the goal iteration or lead step a delegate runs under. */
  parentStepIndex?: number;
}

/** The span attributes beyond {@link PageStepLabels} that a workspace run records. */
export interface LabelExtras {
  /** The workspace id. */
  workspace?: string;
  /** The hash of the harness part of the assembled prompt. */
  harnessPartHash?: string;
  /** The resolved version and sha256 of a `global:` agent ref. */
  agentRef?: { version: string; sha256: string };
  /** The workspace revision; reserved for P5.6. */
  workspaceRevision?: string;
}

/** Builds a step's {@link PageStepLabels}, the only way an engine makes them; throws `ValidationError` for a step kind the page's execution type may not emit or an invalid index. */
export function labelsFor(step: StepLabelInput): PageStepLabels {
  const problems: string[] = [];
  if (!WORK_TYPE_STEP_KINDS[step.executionType].includes(step.stepKind)) problems.push(`a ${step.executionType} page does not emit ${step.stepKind} steps`);
  if (!Number.isInteger(step.stepIndex) || step.stepIndex < 0) problems.push('stepIndex must be a non-negative integer');
  if (step.parentStepIndex !== undefined && (!Number.isInteger(step.parentStepIndex) || step.parentStepIndex < 0)) problems.push('parentStepIndex must be a non-negative integer');
  if (problems.length > 0) throw new ValidationError(`invalid step labels: ${problems.join('; ')}`, { labels: problems }, 'LOUSHO_VALIDATION_FAILED');
  const { page, attachment, harnessHash, executionType, stepKind, stepIndex, parentStepIndex } = step;
  return { page, attachment, harnessHash, executionType, stepKind, stepIndex, ...(parentStepIndex !== undefined && { parentStepIndex }) };
}

/** The `lousho.*` span attributes for a step's labels, ready for `createAgent({ spanAttributes })`. */
export function labelAttributes(labels: PageStepLabels, extras: LabelExtras = {}): Record<string, string | number> {
  const entries: [string, string | number | undefined][] = [
    [SdkAttr.WORKSPACE, extras.workspace],
    [SdkAttr.PAGE, labels.page],
    [SdkAttr.ATTACHMENT, labels.attachment],
    [SdkAttr.EXECUTION_TYPE, labels.executionType],
    [SdkAttr.STEP_KIND, labels.stepKind],
    [SdkAttr.STEP_INDEX, labels.stepIndex],
    [SdkAttr.HARNESS_HASH, labels.harnessHash],
    [SdkAttr.HARNESS_PART_HASH, extras.harnessPartHash],
    [SdkAttr.AGENT_REF_VERSION, extras.agentRef?.version],
    [SdkAttr.AGENT_REF_SHA256, extras.agentRef?.sha256],
    [SdkAttr.WORKSPACE_REVISION, extras.workspaceRevision],
  ];
  return Object.fromEntries(entries.filter((entry): entry is [string, string | number] => entry[1] !== undefined));
}
