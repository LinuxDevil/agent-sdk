import type { AuthoringOp } from '../contracts/authoringOps';
import type { Attachment } from '../contracts/agentRefs';
import type { HarnessLayer } from '../contracts/baseHarness';
import type { EffectiveHarness } from '../contracts/compose';
import type { Harness } from '../contracts/harness';
import type { MainHarness } from '../contracts/mainHarness';
import type { ArtifactRef, PageInput, PageResult, PageRunEvent, PageRunStatus, PageStepLabels } from '../contracts/execution';
import type { PageManifest } from '../contracts/page';
import type { WorkspacePolicy } from '../contracts/policy';
import type { PageUi } from '../contracts/ui';
import type { WorkspaceProblem, WorkspaceProblemCode } from '../contracts/validate';
import type { WorkspaceManifest } from '../contracts/workspace';

/** An opaque revision id of a workspace; every write names the one it was made against. */
export type Revision = string;

/** A workspace in a list. */
export interface WorkspaceSummary {
  /** Workspace id, kebab-case. */
  id: string;
  /** Display name. */
  name: string;
  /** What the workspace is for. */
  description?: string;
  /** Domain label, such as `marketing`. */
  domain?: string;
  /** The live revision. */
  revision: Revision;
  /** How many pages it has. */
  pageCount: number;
  /** Whether it has a main agent. */
  hasMainAgent: boolean;
}

/** One page with its manifest. */
export interface PageDetail {
  /** The workspace the page belongs to. */
  workspaceId: string;
  /** Page id, kebab-case. */
  id: string;
  /** The live revision of the workspace. */
  revision: Revision;
  /** The page's `page.json`. */
  manifest: PageManifest;
  /** Hash of the page's effective harness. */
  harnessHash: string;
}

/** One workspace with its manifest and pages. */
export interface WorkspaceDetail extends WorkspaceSummary {
  /** The `workspace.json`. */
  manifest: WorkspaceManifest;
  /** Every page, in manifest order. */
  pages: PageDetail[];
}

/** A page's harness: the composed result and every layer behind it. */
export interface HarnessView {
  /** The page. */
  pageId: string;
  /** The live revision of the workspace. */
  revision: Revision;
  /** The composed harness. */
  effective: EffectiveHarness;
  /** Layers in applied order; the base harness comes first when the workspace has one. */
  layers: HarnessLayer[];
  /** For each field path, the sources its value came from. */
  provenance: Record<string, string[]>;
  /** Hash of the composed harness. */
  hash: string;
}

/** The main-agent harness. */
export interface MainHarnessView {
  /** The live revision of the workspace. */
  revision: Revision;
  /** The harness; absent when the workspace has no main agent. */
  harness?: MainHarness;
}

/** What an attached agent owns itself and a page cannot change. */
export interface AgentOwnedView {
  /** The agent's instruction prose. */
  instructions?: string;
  /** Skill names. */
  skills: string[];
  /** Tool names. */
  tools: string[];
  /** Memory slot name. */
  memory?: string;
  /** The agent's own default model. */
  defaultModel?: string;
}

/** An agent attached to a page, split into what the agent owns and what the page owns. */
export interface AttachmentView {
  /** Alias on the page. */
  as: string;
  /** The agent ref. */
  ref: string;
  /** Read-only values from the agent. */
  agentOwned: AgentOwnedView;
  /** The page's own settings from `agents.json`. */
  pageOwned: Attachment;
}

/** A page's UI spec. */
export interface PageUiView {
  /** The page. */
  pageId: string;
  /** The live revision of the workspace. */
  revision: Revision;
  /** The declarative UI. */
  ui: PageUi;
}

/** `OPERATION` marks a problem raised by one authoring operation rather than a validator rule. */
export type ProblemViewCode = WorkspaceProblemCode | 'OPERATION';

/** A validation problem as the clients show it. */
export interface ProblemView extends Omit<WorkspaceProblem, 'code'> {
  /** The rule code, or `OPERATION`. */
  code: ProblemViewCode;
  /** Index in the batch of the operation that caused it. */
  opIndex?: number;
  /** The operation's name, when `opIndex` is set. */
  op?: string;
}

/** What every write returns. */
export interface WriteResult {
  /** The revision after the write. */
  revision: Revision;
  /** Problems found; empty when clean. */
  problems: ProblemView[];
}

/** One revision in a workspace's history. */
export interface HistoryEntryView {
  /** The revision id. */
  revision: Revision;
  /** ISO time it was written. */
  at: string;
  /** Who wrote it. */
  by: string;
  /** What kind of write, such as `authoring` or `improvement`. */
  kind: string;
  /** One line about the change. */
  summary: string;
}

/** One changed field inside a JSON file. */
export interface DraftFieldChange {
  /** Dotted path of the field. */
  path: string;
  /** The value before. */
  before?: unknown;
  /** The value after. */
  after?: unknown;
}

/** The change to one file. */
export interface DraftFileDiff {
  /** The file, relative to the workspace root. */
  file: string;
  /** Whether the file is new, gone or edited. */
  change: 'added' | 'removed' | 'modified';
  /** `prose` files get a text diff and `json` files a structural one. */
  kind: 'prose' | 'json';
  /** Unified text diff, for prose. */
  text?: string;
  /** Field changes, for JSON. */
  changes?: DraftFieldChange[];
}

/** A page whose effective harness hash a draft changes. */
export interface DraftHarnessHashChange {
  /** The page. */
  page: string;
  /** The hash now; absent for a new page. */
  before?: string;
  /** The hash after the draft; absent for a removed page. */
  after?: string;
}

/** What a draft changes. */
export interface DraftDiffView {
  /** The change to each file. */
  files: DraftFileDiff[];
  /** Pages whose effective harness hash changes. */
  changedHarnessHashes: DraftHarnessHashChange[];
}

/** A draft revision. */
export interface DraftView {
  /** Draft id. */
  id: string;
  /** The workspace. */
  workspaceId: string;
  /** The revision the draft was opened on. */
  baseRevision: Revision;
  /** Who opened it. */
  createdBy: string;
  /** ISO time of the last change. */
  updatedAt: string;
  /** The operations applied so far. */
  operations: AuthoringOp[];
  /** What the draft changes. */
  diff: DraftDiffView;
  /** Problems in the draft's tree. */
  problems: ProblemView[];
}

/** What applying operations returns. */
export interface ApplyOpsView {
  /** The draft the operations landed in. */
  draftId: string;
  /** Problems, each with the index of the operation that caused it. */
  problems: ProblemView[];
  /** What the draft changes. */
  diff: DraftDiffView;
}

/** A run's state: a final {@link PageRunStatus}, or one of the states of a run still in the service. */
export type RunViewStatus = PageRunStatus | 'queued' | 'running' | 'interrupted';

/** A run. */
export interface PageRunView {
  /** Run id. */
  runId: string;
  /** The workspace. */
  workspaceId: string;
  /** The page it runs; absent for a workspace chat run that has not routed yet. */
  pageId?: string;
  /** Where the run is. */
  status: RunViewStatus;
  /** ISO start time. */
  startedAt: string;
  /** ISO end time. */
  endedAt?: string;
  /** What the run was given. */
  input?: PageInput;
  /** The result, once the run ended or paused. */
  result?: PageResult;
  /** The id of the last event in the run's log. */
  lastEventId?: number;
}

/** An artifact with its content. */
export interface ArtifactView {
  /** The artifact's reference. */
  artifact: ArtifactRef;
  /** The content, for text artifacts. */
  text?: string;
}

/** One span of a run's trace. */
export interface RunTraceSpan {
  /** Span id. */
  spanId: string;
  /** The parent span. */
  parentSpanId?: string;
  /** What the span did. */
  name: string;
  /** ISO start time. */
  startedAt: string;
  /** ISO end time. */
  endedAt?: string;
  /** The step labels, for a step span. */
  labels?: PageStepLabels;
}

/** A run's trace. */
export interface RunTraceView {
  /** Run id. */
  runId: string;
  /** The trace id. */
  traceId?: string;
  /** Spans in start order. */
  spans: RunTraceSpan[];
}

/** One event on the wire; `id` rises by one per event within a run, so a reconnect can resume after the last one it saw. */
export interface WireRunEvent {
  /** Position in the run's event log, from 0; sent as the SSE `id:` and as `Last-Event-ID` on reconnect. */
  id: number;
  /** The run. */
  runId: string;
  /** The engine event. */
  event: PageRunEvent;
}

/** Where a proposal stands. */
export type ProposalStatus = 'pending' | 'first-approved' | 'approved' | 'rejected';

/** The held-out check of a proposal. */
export interface HeldOutReportView {
  /** Whether the held-out cases passed. */
  passed: boolean;
  /** The score, when there is one. */
  score?: number;
  /** What was checked. */
  summary: string;
}

/** An improvement proposal waiting for a decision. */
export interface ProposalView {
  /** Proposal id. */
  id: string;
  /** The page it changes. */
  pageId: string;
  /** Where it stands. */
  status: ProposalStatus;
  /** One line about the change. */
  summary: string;
  /** The change to each file. */
  diff: DraftFileDiff[];
  /** The runs and findings behind it. */
  evidence: string[];
  /** The held-out check. */
  heldOut?: HeldOutReportView;
  /** ISO time it was proposed. */
  createdAt: string;
}

/** What starting a run returns. */
export interface StartRunResult {
  /** The new run. */
  runId: string;
}

/** The body of every write. */
export interface WriteBody {
  /** The revision the caller read; a different live revision is a 409. */
  expectedRevision: Revision;
}

/** Replaces the workspace policy. */
export interface SetPolicyBody extends WriteBody {
  /** The new policy. */
  policy: WorkspacePolicy;
}

/** Writes one shared file. */
export interface WriteSharedFileBody extends WriteBody {
  /** The path under `shared/`. */
  path: string;
  /** The file text. */
  content: string;
}

/** Writes the files of one workspace harness profile. */
export interface WriteProfileBody extends WriteBody {
  /** Files by path inside the profile folder; `harness.json` is the profile and `.md` files are prose. */
  files: Record<string, Harness | string>;
}

/** Applies authoring operations. */
export interface ApplyOpsBody extends WriteBody {
  /** The draft to add to; omitted opens a new one on `expectedRevision`. */
  draftId?: string;
  /** The operations, applied in order. */
  ops: AuthoringOp[];
}

/** Starts a run of one page. */
export interface StartPageRunBody {
  /** What to run. */
  input: PageInput;
  /** Run against this revision; a different live revision is a 409. */
  expectedRevision?: Revision;
}

/** Starts a workspace chat run. */
export interface StartWorkspaceRunBody {
  /** The user's message. */
  message: string;
  /** The page to run when the workspace has no main agent. */
  pageId?: string;
  /** Continue this thread. */
  threadId?: string;
  /** Run against this revision; a different live revision is a 409. */
  expectedRevision?: Revision;
}

/** Answers a paused run. */
export interface ApproveRunBody {
  /** The pending approval. */
  approvalId: string;
  /** What was decided. */
  decision: 'approve' | 'deny';
  /** The answer, for a `question` approval. */
  answer?: string;
  /** Why, for the record. */
  reason?: string;
}

/** Approves a proposal at one of its two steps. */
export interface ApproveProposalBody extends WriteBody {
  /** Which approval this is. */
  step: 'first' | 'second';
}

/** Rejects a proposal. */
export interface RejectProposalBody extends WriteBody {
  /** Why. */
  reason?: string;
}
