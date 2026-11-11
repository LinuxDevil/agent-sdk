import type { ApprovalKind } from '../../execution/ApprovalGate';
import { ValidationError } from '../../execution/errors';
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
  /** The step's position in one sequence across the whole run, from 0, whatever the step kind. */
  stepIndex: number;
  /** The `stepIndex` of the goal iteration or lead step a delegate runs under; absent on a top-level step. */
  parentStepIndex?: number;
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
  /** `true` when `costUsd` is a lower bound because some model call had no known price. */
  costPartial?: boolean;
  /** Model calls made, including delegates. */
  modelCalls?: number;
}

/** Why a page run did not end `ok`; the named kinds are the ones the runtime sets, and engines may add their own. */
export type PageErrorKind = 'invalid-input' | 'invalid-output' | 'budget' | 'timeout' | 'cancelled' | 'stalled' | 'engine' | (string & {});

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
    /** A short machine-readable kind, for example `invalid-input`, `budget` or `engine`. */
    kind: PageErrorKind;
    /** What went wrong, for people. */
    message: string;
  };
}

/** An artifact's content: text (written as UTF-8), bytes, or a stream of byte chunks. */
export type ArtifactData = string | Uint8Array | AsyncIterable<Uint8Array>;

/** Where an engine writes the run's artifacts. */
export interface ArtifactSink {
  /** Stores one artifact for this run and returns its reference. */
  put(name: string, data: ArtifactData, mediaType: string): Promise<ArtifactRef>;
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

const SEGMENT_RULE = 'must be 1 to 255 UTF-8 bytes of well-formed text, must not start with `.`, and must not contain `/`, `\\`, control, format or line and paragraph separator characters';

const MAX_SEGMENT_BYTES = 255;

const FORBIDDEN_CHARS = /[/\\\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const utf8 = new TextEncoder();

/** Whether `segment` is a safe artifact URI segment: 1 to 255 UTF-8 bytes, no leading dot, no separators or control characters. */
export function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && !segment.startsWith('.') && !FORBIDDEN_CHARS.test(segment) && utf8.encode(segment).length <= MAX_SEGMENT_BYTES;
}

function uriProblems(parts: ArtifactUriParts): Record<string, string[]> {
  const problems: Record<string, string[]> = {};
  if (!KEBAB_CASE.test(parts.workspace)) problems.workspace = ['must be kebab-case'];
  if (!isSafeSegment(parts.runId)) problems.runId = [SEGMENT_RULE];
  if (!isSafeSegment(parts.name)) problems.name = [SEGMENT_RULE];
  return problems;
}

function describeProblems(problems: Record<string, string[]>): string {
  return Object.entries(problems)
    .map(([field, messages]) => `${field}: ${messages.join('; ')}`)
    .join('\n');
}

/** Builds `artifact://<workspace>/<runId>/<name>`, percent-encoding each segment; throws `ValidationError` on a part `parseArtifactUri` would reject. */
export function formatArtifactUri(parts: ArtifactUriParts): string {
  const problems = uriProblems(parts);
  if (Object.keys(problems).length > 0) throw new ValidationError(`invalid artifact uri parts:\n${describeProblems(problems)}`, problems, 'LOUSHO_VALIDATION_FAILED');
  return `artifact://${parts.workspace}/${encodeURIComponent(parts.runId)}/${encodeURIComponent(parts.name)}`;
}

const ARTIFACT_URI = /^artifact:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

function decodeParts(match: RegExpExecArray): ArtifactUriParts | undefined {
  try {
    return { workspace: match[1], runId: decodeURIComponent(match[2]), name: decodeURIComponent(match[3]) };
  } catch {
    return undefined;
  }
}

function isValidParts(parts: ArtifactUriParts): boolean {
  return Object.keys(uriProblems(parts)).length === 0;
}

/** Parses an artifact uri, or returns `undefined` when it is not one; the decoded runId and name follow the same segment rule as `formatArtifactUri`. */
export function parseArtifactUri(uri: string): ArtifactUriParts | undefined {
  const match = ARTIFACT_URI.exec(uri);
  const decoded = match ? decodeParts(match) : undefined;
  return decoded && isValidParts(decoded) ? decoded : undefined;
}
