import type { ApprovalKind } from '../../execution/ApprovalGate';
import { KEBAB_CASE } from './common';
import type { PageExecutionLimits, WorkType } from './page';

/** How a page run ended, or `needs-approval` while it waits on a decision. */
export type PageRunStatus = 'ok' | 'failed' | 'timed-out' | 'cancelled' | 'needs-approval';

/** Every {@link PageRunStatus}. */
export const PAGE_RUN_STATUSES: readonly PageRunStatus[] = ['ok', 'failed', 'timed-out', 'cancelled', 'needs-approval'];

/** True for a status that ends the run; `needs-approval` can resume, so it is not terminal. */
export function isTerminalStatus(status: PageRunStatus): boolean {
  return status !== 'needs-approval';
}

/** The kind of step a span belongs to, the same words on every engine. */
export type StepKind = 'single' | 'workflow-step' | 'delegate' | 'goal-iteration';

/** Every {@link StepKind}. */
export const STEP_KINDS: readonly StepKind[] = ['single', 'workflow-step', 'delegate', 'goal-iteration'];

/** The step kinds an engine of each {@link WorkType} may emit. */
export const WORK_TYPE_STEP_KINDS: Readonly<Record<WorkType, readonly StepKind[]>> = {
  single: ['single'],
  'multi-agent': ['single', 'delegate'],
  workflow: ['workflow-step', 'delegate'],
  'goal-oriented': ['goal-iteration', 'delegate'],
};

/** The labels every engine puts on a step's spans and events; attribution reads only these. */
export interface PageStepLabels {
  /** Page id. */
  page: string;
  /** Attachment alias from `agents.json` that ran the step. */
  attachment: string;
  /** The composed harness hash, the id `harnessHash` gives. */
  harnessHash: string;
  /** The page's active execution type. */
  executionType: WorkType;
  /** What kind of step this is. */
  stepKind: StepKind;
  /** The step's position in the run, from 0; for a goal, the iteration index. */
  stepIndex: number;
}

/** The run-level labels the runtime hands an engine; the engine adds the per-step ones. */
export type PageRunLabels = Pick<PageStepLabels, 'page' | 'harnessHash' | 'executionType'>;

/** What the main agent or the UI hands a page to run. */
export interface PageInput {
  /** The page to run. */
  pageId: string;
  /** The task, in words. */
  task: string;
  /** Structured inputs, validated against the page's input schema. */
  inputs?: unknown;
  /** Revise an earlier run's result instead of starting fresh. */
  revise?: {
    /** The run to revise. */
    runId: string;
    /** What to change. */
    instruction: string;
  };
  /** The run that started this one, when a run calls a page. */
  parentRunId?: string;
}

/** A file a page run produced, addressed as `artifact://<workspace>/<runId>/<name>`. */
export interface ArtifactRef {
  /** File name inside the run's artifact directory. */
  name: string;
  /** Media type, for example `text/markdown`. */
  mediaType: string;
  /** `artifact://<workspace>/<runId>/<name>`, built by {@link formatArtifactUri}. */
  uri: string;
  /** Size in bytes. */
  bytes: number;
  /** Hex SHA-256 of the content. */
  sha256: string;
}

/** The parts of an artifact uri. */
export interface ArtifactUriParts {
  /** Workspace id, kebab-case. */
  workspace: string;
  /** The run that produced the artifact. */
  runId: string;
  /** File name inside the run's artifact directory. */
  name: string;
}

/** Token and spend totals of a page run, named as on `RunUsage`. */
export interface PageUsage {
  /** Tokens sent to models. */
  inputTokens: number;
  /** Tokens models generated. */
  outputTokens: number;
  /** `inputTokens + outputTokens`. */
  totalTokens: number;
  /** USD for the run; absent when a model's price is unknown. */
  costUsd?: number;
  /** Model calls made, including delegates. */
  modelCalls?: number;
}

/** What a page run returns; plain JSON, so the wire contract reuses it. */
export interface PageResult {
  /** How the run ended. */
  status: PageRunStatus;
  /** The structured output, validated against the page's output schema. */
  output?: unknown;
  /** Files the run produced. */
  artifacts: ArtifactRef[];
  /** What the main agent sees. */
  summary: string;
  /** Token and spend totals. */
  usage: PageUsage;
  /** This run's id. */
  runId: string;
  /** The trace the run's spans belong to. */
  traceId?: string;
  /** The last checkpoint, to resume from. */
  checkpointId?: string;
  /** Why the run did not end `ok`. */
  error?: {
    /** A short machine-readable kind, for example `limit` or `engine`. */
    kind: string;
    /** What went wrong, for people. */
    message: string;
  };
}

/** Where an engine writes the run's artifacts. */
export interface ArtifactSink {
  /** Stores one artifact for this run and returns its reference. */
  put(name: string, data: string | Uint8Array, mediaType: string): Promise<ArtifactRef>;
}

/** A page run began. */
export interface PageStartedEvent extends PageRunLabels {
  /** Discriminant. */
  type: 'started';
}

/** A step began or finished; it carries the step's labels. */
export interface PageStepEvent extends PageStepLabels {
  /** Discriminant. */
  type: 'step';
  /** `start` or `done`, as `step.start` and `step.done` on agent events. */
  phase: 'start' | 'done';
}

/** The run stored an artifact. */
export interface PageArtifactEvent {
  /** Discriminant. */
  type: 'artifact';
  /** The stored artifact. */
  artifact: ArtifactRef;
}

/** The run paused on an approval. */
export interface PageApprovalEvent {
  /** Discriminant. */
  type: 'approval';
  /** The pending approval's id. */
  approvalId: string;
  /** What the pause waits on. */
  kind: ApprovalKind;
  /** The pause's ISO deadline, when it has one. */
  expiresAt?: string;
}

/** A progress note for the UI. */
export interface PageProgressEvent {
  /** Discriminant. */
  type: 'progress';
  /** What the run is doing, for people. */
  message: string;
  /** Share done, from 0 to 1, when known. */
  fraction?: number;
}

/** The run ended or paused. */
export interface PageFinishedEvent {
  /** Discriminant. */
  type: 'finished';
  /** The result's status. */
  status: PageRunStatus;
}

/** Every event an engine emits, discriminated by `type`. */
export type PageRunEvent = PageStartedEvent | PageStepEvent | PageArtifactEvent | PageApprovalEvent | PageProgressEvent | PageFinishedEvent;

/** What the runtime hands an engine for one run. */
export interface PageRunContext {
  /** This run's id. */
  runId: string;
  /** Aborts the run on cancel or timeout. */
  signal: AbortSignal;
  /** The page's execution limits. */
  limits: PageExecutionLimits;
  /** Run-level labels. */
  labels: PageRunLabels;
  /** Where the run writes artifacts. */
  artifacts: ArtifactSink;
  /** Reports a run event. */
  emit(event: PageRunEvent): void;
}

/** The execution seam: one engine per {@link WorkType}. */
export interface PageEngine {
  /** The execution type this engine runs. */
  type: WorkType;
  /** Runs one page input to a result. */
  run(input: PageInput, ctx: PageRunContext): Promise<PageResult>;
}

/** Builds `artifact://<workspace>/<runId>/<name>`, percent-encoding each segment. */
export function formatArtifactUri(parts: ArtifactUriParts): string {
  return `artifact://${parts.workspace}/${encodeURIComponent(parts.runId)}/${encodeURIComponent(parts.name)}`;
}

const ARTIFACT_URI = /^artifact:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function isSafeName(name: string | undefined): name is string {
  return name !== undefined && name !== '.' && name !== '..';
}

/** Parses an artifact uri, or returns `undefined` when it is not one. */
export function parseArtifactUri(uri: string): ArtifactUriParts | undefined {
  const match = ARTIFACT_URI.exec(uri);
  if (!match || !KEBAB_CASE.test(match[1])) return undefined;
  const runId = decodeSegment(match[2]);
  const name = decodeSegment(match[3]);
  if (!isSafeName(runId) || !isSafeName(name)) return undefined;
  return { workspace: match[1], runId, name };
}
