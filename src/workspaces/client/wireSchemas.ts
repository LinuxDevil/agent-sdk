import { z } from 'zod';
import { attachmentObjectSchema } from '../contracts/agentRefs';
import { harnessSchema } from '../contracts/harness';
import { mainHarnessSchema } from '../contracts/mainHarness';
import { workspaceManifestSchema } from '../contracts/workspace';
import { pageSchema } from '../contracts/page';
import { pageUiSchema } from '../contracts/ui';
import { workspacePolicySchema } from '../contracts/policy';
import { authoringOpSchema } from '../contracts/authoringOps';
import { workspacePathSchema } from '../contracts/common';
import { PAGE_RUN_STATUSES, STEP_KINDS, type ArtifactRef, type PageInput, type PageResult, type PageRunEvent, type StepKind } from '../contracts/execution';
import { WORK_TYPES, type WorkType } from '../contracts/page';
import type { EffectiveHarness } from '../contracts/compose';
import type { HarnessLayer } from '../contracts/baseHarness';
import type { PageRunStatus, PageUsage } from '../contracts/execution';
import type {
  AgentOwnedView,
  ApplyOpsBody,
  ApplyOpsView,
  ApproveProposalBody,
  ApproveRunBody,
  ArtifactView,
  AttachmentView,
  DraftDiffView,
  DraftFileDiff,
  DraftView,
  HarnessView,
  HeldOutReportView,
  HistoryEntryView,
  MainHarnessView,
  PageDetail,
  PageRunView,
  PageUiView,
  ProblemView,
  ProblemViewCode,
  ProposalStatus,
  ProposalView,
  RejectProposalBody,
  RunTraceView,
  RunViewStatus,
  SetPolicyBody,
  StartPageRunBody,
  StartRunResult,
  StartWorkspaceRunBody,
  WireRunEvent,
  WorkspaceDetail,
  WorkspaceSummary,
  WriteBody,
  WriteProfileBody,
  WriteResult,
  WriteSharedFileBody,
} from './wireTypes';

const oneOf = <T extends string>(values: readonly T[]): z.ZodType<T> =>
  z.custom<T>((value) => typeof value === 'string' && (values as readonly string[]).includes(value), `must be one of ${values.join(', ')}`);

const text = z.string();
const id = z.string().min(1);
const count = z.number().int().min(0);
const iso = z.string().min(1);
const revision = z.string().min(1);
const strings = z.array(text);

export const writeBodySchema: z.ZodType<WriteBody> = z.object({ expectedRevision: revision });

const stepLabels = {
  page: id,
  attachment: id,
  harnessHash: id,
  executionType: oneOf<WorkType>(WORK_TYPES),
  stepKind: oneOf<StepKind>(STEP_KINDS),
  stepIndex: count,
  parentStepIndex: count.optional(),
};

const stepLabelsSchema = z.object(stepLabels);

const artifactRefSchema: z.ZodType<ArtifactRef> = z.object({ name: id, mediaType: id, uri: id, bytes: count, sha256: id });

const statusSchema = oneOf<PageRunStatus>(PAGE_RUN_STATUSES);

const usageSchema: z.ZodType<PageUsage> = z.object({
  inputTokens: count,
  outputTokens: count,
  totalTokens: count,
  costUsd: z.number().min(0).optional(),
  costPartial: z.boolean().optional(),
  modelCalls: count.optional(),
});

export const pageRunEventSchema: z.ZodType<PageRunEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), page: id, harnessHash: id, executionType: stepLabels.executionType }),
  z.object({ type: z.literal('step'), phase: z.enum(['start', 'done']), ...stepLabels }),
  z.object({ type: z.literal('artifact'), artifact: artifactRefSchema }),
  z.object({ type: z.literal('approval'), approvalId: id, kind: z.enum(['tool', 'question', 'sign-in']), expiresAt: iso.optional() }),
  z.object({ type: z.literal('progress'), message: text, fraction: z.number().min(0).max(1).optional() }),
  z.object({ type: z.literal('finished'), status: statusSchema, usage: usageSchema.optional() }),
]);

export const RUN_EVENT_TYPES: readonly string[] = ['started', 'step', 'artifact', 'approval', 'progress', 'finished'];

export const wireEnvelopeSchema = z.object({ id: count, runId: id, event: z.object({ type: text }) });

export const wireRunEventSchema: z.ZodType<WireRunEvent> = z.object({ id: count, runId: id, event: pageRunEventSchema });

export const pageInputSchema: z.ZodType<PageInput> = z.object({
  pageId: id,
  task: text,
  inputs: z.unknown().optional(),
  revise: z.object({ runId: id, instruction: text }).optional(),
  parentRunId: id.optional(),
});

const pageResultSchema: z.ZodType<PageResult> = z.object({
  status: statusSchema,
  output: z.unknown().optional(),
  artifacts: z.array(artifactRefSchema),
  summary: text,
  usage: usageSchema,
  runId: id,
  traceId: id.optional(),
  checkpointId: id.optional(),
  error: z.object({ kind: text, message: text }).optional(),
});

const problemCode = z.custom<ProblemViewCode>((value) => typeof value === 'string' && (/^PRD\d{3}$/.test(value) || value === 'OPERATION'), 'must be PRD### or OPERATION');

export const problemViewSchema: z.ZodType<ProblemView> = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: problemCode,
  file: text,
  path: text,
  message: text,
  opIndex: count.optional(),
  op: text.optional(),
});

const problems = z.array(problemViewSchema);

export const writeResultSchema: z.ZodType<WriteResult> = z.object({ revision, problems });

const summarySchema: z.ZodType<WorkspaceSummary> = z.object({
  id,
  name: id,
  description: text.optional(),
  domain: text.optional(),
  revision,
  pageCount: count,
  hasMainAgent: z.boolean(),
});

export const pageDetailSchema: z.ZodType<PageDetail> = z.object({ workspaceId: id, id, revision, manifest: pageSchema, harnessHash: id });

export const workspaceDetailSchema: z.ZodType<WorkspaceDetail> = z.object({
  id,
  name: id,
  description: text.optional(),
  domain: text.optional(),
  revision,
  pageCount: count,
  hasMainAgent: z.boolean(),
  manifest: workspaceManifestSchema,
  pages: z.array(pageDetailSchema),
});

const provenance = z.record(z.string(), strings);

const effectiveHarnessSchema = z.object({
  sources: strings,
  instructions: text,
  audience: z.unknown().optional(),
  platform: z.unknown().optional(),
  inputs: z.unknown().optional(),
  outputs: z.unknown().optional(),
  capabilities: z.unknown().optional(),
  constraints: z.unknown().optional(),
  evaluation: z.unknown().optional(),
  runtime: z.unknown().optional(),
  context: z.unknown().optional(),
  provenance,
  hash: id,
}) as unknown as z.ZodType<EffectiveHarness>;

const harnessLayerSchema: z.ZodType<HarnessLayer> = z.object({ source: id, harness: harnessSchema, texts: z.record(z.string(), text) });

export const harnessViewSchema: z.ZodType<HarnessView> = z.object({
  pageId: id,
  revision,
  effective: effectiveHarnessSchema,
  layers: z.array(harnessLayerSchema),
  provenance,
  hash: id,
});

export const mainHarnessViewSchema: z.ZodType<MainHarnessView> = z.object({ revision, harness: mainHarnessSchema.optional() });

const agentOwnedSchema: z.ZodType<AgentOwnedView> = z.object({
  instructions: text.optional(),
  skills: strings,
  tools: strings,
  memory: text.optional(),
  defaultModel: text.optional(),
});

export const attachmentViewSchema: z.ZodType<AttachmentView> = z.object({
  as: id,
  ref: id,
  agentOwned: agentOwnedSchema,
  pageOwned: attachmentObjectSchema,
});

export const pageUiViewSchema: z.ZodType<PageUiView> = z.object({ pageId: id, revision, ui: pageUiSchema });

export const historyEntrySchema: z.ZodType<HistoryEntryView> = z.object({ revision, at: iso, by: id, kind: id, summary: text });

const draftFileDiffSchema: z.ZodType<DraftFileDiff> = z.object({
  file: id,
  change: z.enum(['added', 'removed', 'modified']),
  kind: z.enum(['prose', 'json']),
  text: text.optional(),
  changes: z.array(z.object({ path: text, before: z.unknown().optional(), after: z.unknown().optional() })).optional(),
});

const draftDiffSchema: z.ZodType<DraftDiffView> = z.object({
  files: z.array(draftFileDiffSchema),
  changedHarnessHashes: z.array(z.object({ page: id, before: id.optional(), after: id.optional() })),
});

export const draftViewSchema: z.ZodType<DraftView> = z.object({
  id,
  workspaceId: id,
  baseRevision: revision,
  createdBy: id,
  updatedAt: iso,
  operations: z.array(authoringOpSchema),
  diff: draftDiffSchema,
  problems,
});

export const applyOpsViewSchema: z.ZodType<ApplyOpsView> = z.object({ draftId: id, problems, diff: draftDiffSchema });

const runStatusSchema = oneOf<RunViewStatus>([...PAGE_RUN_STATUSES, 'queued', 'running', 'interrupted']);

export const pageRunViewSchema: z.ZodType<PageRunView> = z.object({
  runId: id,
  workspaceId: id,
  pageId: id.optional(),
  status: runStatusSchema,
  startedAt: iso,
  endedAt: iso.optional(),
  input: pageInputSchema.optional(),
  result: pageResultSchema.optional(),
  lastEventId: count.optional(),
});

export const artifactViewSchema: z.ZodType<ArtifactView> = z.object({ artifact: artifactRefSchema, text: text.optional() });

export const runTraceViewSchema: z.ZodType<RunTraceView> = z.object({
  runId: id,
  traceId: id.optional(),
  spans: z.array(z.object({ spanId: id, parentSpanId: id.optional(), name: id, startedAt: iso, endedAt: iso.optional(), labels: stepLabelsSchema.optional() })),
});

const heldOutSchema: z.ZodType<HeldOutReportView> = z.object({ passed: z.boolean(), score: z.number().optional(), summary: text });

export const proposalViewSchema: z.ZodType<ProposalView> = z.object({
  id,
  pageId: id,
  status: oneOf<ProposalStatus>(['pending', 'first-approved', 'approved', 'rejected']),
  summary: text,
  diff: z.array(draftFileDiffSchema),
  evidence: strings,
  heldOut: heldOutSchema.optional(),
  createdAt: iso,
});

export const startRunResultSchema: z.ZodType<StartRunResult> = z.object({ runId: id });

export const workspaceSummariesSchema = z.array(summarySchema);

export const setPolicyBodySchema: z.ZodType<SetPolicyBody> = z.object({ expectedRevision: revision, policy: workspacePolicySchema });

export const writeSharedFileBodySchema: z.ZodType<WriteSharedFileBody> = z.object({ expectedRevision: revision, path: workspacePathSchema, content: text });

export const writeProfileBodySchema: z.ZodType<WriteProfileBody> = z.object({
  expectedRevision: revision,
  files: z.record(workspacePathSchema, z.union([harnessSchema, text])),
});

export const applyOpsBodySchema: z.ZodType<ApplyOpsBody> = z.object({ expectedRevision: revision, draftId: id.optional(), ops: z.array(authoringOpSchema).min(1) });

export const startPageRunBodySchema: z.ZodType<StartPageRunBody> = z.object({ input: pageInputSchema, expectedRevision: revision.optional() });

export const startWorkspaceRunBodySchema: z.ZodType<StartWorkspaceRunBody> = z.object({
  message: id,
  pageId: id.optional(),
  threadId: id.optional(),
  expectedRevision: revision.optional(),
});

export const approveRunBodySchema: z.ZodType<ApproveRunBody> = z.object({
  approvalId: id,
  decision: z.enum(['approve', 'deny']),
  answer: text.optional(),
  reason: text.optional(),
});

export const approveProposalBodySchema: z.ZodType<ApproveProposalBody> = z.object({ expectedRevision: revision, step: z.enum(['first', 'second']) });

export const rejectProposalBodySchema: z.ZodType<RejectProposalBody> = z.object({ expectedRevision: revision, reason: text.optional() });

export const apiErrorBodySchema = z.object({
  error: text,
  currentRevision: revision.optional(),
  problems: problems.optional(),
});
