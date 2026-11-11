import { z } from 'zod';
import {
  applyOpsBodySchema,
  applyOpsViewSchema,
  approveProposalBodySchema,
  approveRunBodySchema,
  artifactViewSchema,
  attachmentViewSchema,
  draftViewSchema,
  harnessViewSchema,
  historyEntrySchema,
  mainHarnessViewSchema,
  pageDetailSchema,
  pageRunViewSchema,
  pageUiViewSchema,
  problemViewSchema,
  proposalViewSchema,
  rejectProposalBodySchema,
  runTraceViewSchema,
  setPolicyBodySchema,
  startPageRunBodySchema,
  startRunResultSchema,
  startWorkspaceRunBodySchema,
  wireRunEventSchema,
  workspaceDetailSchema,
  workspaceSummariesSchema,
  writeBodySchema,
  writeProfileBodySchema,
  writeResultSchema,
  writeSharedFileBodySchema,
} from './wireSchemas';
import type {
  ApplyOpsBody,
  ApplyOpsView,
  ApproveProposalBody,
  ApproveRunBody,
  ArtifactView,
  AttachmentView,
  DraftView,
  HarnessView,
  HistoryEntryView,
  MainHarnessView,
  PageDetail,
  PageRunView,
  PageUiView,
  ProblemView,
  ProposalView,
  RejectProposalBody,
  RunTraceView,
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

/** Path parameters of a route that names no workspace. */
export type NoParams = Record<never, never>;

/** Path parameters of a route under one workspace. */
export interface WorkspaceParams {
  /** Workspace id. */
  id: string;
}

/** Path parameters of a route under one page. */
export interface PageParams extends WorkspaceParams {
  /** Page id. */
  page: string;
}

/** Path parameters of a route under one run. */
export interface RunParams extends WorkspaceParams {
  /** Run id. */
  runId: string;
}

/** Path parameters of a route under one draft. */
export interface DraftParams extends WorkspaceParams {
  /** Draft id. */
  draftId: string;
}

/** Path parameters of a route under one proposal. */
export interface ProposalParams extends WorkspaceParams {
  /** Proposal id. */
  proposalId: string;
}

/** Path parameters of a route under one artifact. */
export interface ArtifactParams extends RunParams {
  /** File name inside the run's artifact directory. */
  name: string;
}

/** Path parameters of a route under one workspace harness profile. */
export interface ProfileParams extends WorkspaceParams {
  /** Profile path, such as `platforms/instagram`, sent URL-encoded as one segment. */
  profile: string;
}

/** The parts of one route: its path parameters, request body and response. */
export interface RouteShape<Params, Body, Response> {
  /** Values for the `:name` segments of the path. */
  params: Params;
  /** The JSON request body; `undefined` when the route takes none. */
  body: Body;
  /** The JSON response, or for a stream one event. */
  response: Response;
}

/** Request and response types of every route in {@link WORKSPACE_ROUTES}. */
export interface WorkspaceRouteTypes {
  /** All workspaces. */
  listWorkspaces: RouteShape<NoParams, undefined, WorkspaceSummary[]>;
  /** One workspace with its pages. */
  getWorkspace: RouteShape<WorkspaceParams, undefined, WorkspaceDetail>;
  /** The pages of a workspace. */
  listPages: RouteShape<WorkspaceParams, undefined, PageDetail[]>;
  /** One page. */
  getPage: RouteShape<PageParams, undefined, PageDetail>;
  /** A page's effective harness. */
  getEffectiveHarness: RouteShape<PageParams, undefined, HarnessView>;
  /** The main-agent harness. */
  getMainHarness: RouteShape<WorkspaceParams, undefined, MainHarnessView>;
  /** A page's attached agents. */
  getAttachments: RouteShape<PageParams, undefined, AttachmentView[]>;
  /** A page's UI spec. */
  getPageUi: RouteShape<PageParams, undefined, PageUiView>;
  /** Every validation problem of the live revision. */
  getProblems: RouteShape<WorkspaceParams, undefined, ProblemView[]>;
  /** The revision history, newest first. */
  getHistory: RouteShape<WorkspaceParams, undefined, HistoryEntryView[]>;
  /** Replaces the workspace policy; people only. */
  setPolicy: RouteShape<WorkspaceParams, SetPolicyBody, WriteResult>;
  /** Writes a shared file; people only. */
  writeSharedFile: RouteShape<WorkspaceParams, WriteSharedFileBody, WriteResult>;
  /** Writes a workspace harness profile; people only. */
  writeProfile: RouteShape<ProfileParams, WriteProfileBody, WriteResult>;
  /** Applies authoring operations to a draft. */
  applyOps: RouteShape<WorkspaceParams, ApplyOpsBody, ApplyOpsView>;
  /** The open drafts. */
  listDrafts: RouteShape<WorkspaceParams, undefined, DraftView[]>;
  /** One draft. */
  getDraft: RouteShape<DraftParams, undefined, DraftView>;
  /** Applies a draft as one revision. */
  applyDraft: RouteShape<DraftParams, WriteBody, WriteResult>;
  /** Replays a draft's operations on the new head. */
  rebaseDraft: RouteShape<DraftParams, undefined, DraftView>;
  /** Discards a draft. */
  discardDraft: RouteShape<DraftParams, undefined, WriteResult>;
  /** Starts a page run. */
  startPageRun: RouteShape<PageParams, StartPageRunBody, StartRunResult>;
  /** Starts a workspace chat run. */
  startWorkspaceRun: RouteShape<WorkspaceParams, StartWorkspaceRunBody, StartRunResult>;
  /** A run's events over SSE. */
  streamRunEvents: RouteShape<RunParams, undefined, WireRunEvent>;
  /** Cancels a run. */
  cancelRun: RouteShape<RunParams, undefined, PageRunView>;
  /** Answers a paused run. */
  approveRun: RouteShape<RunParams, ApproveRunBody, PageRunView>;
  /** A run with its result. */
  getRun: RouteShape<RunParams, undefined, PageRunView>;
  /** A run's trace. */
  getRunTrace: RouteShape<RunParams, undefined, RunTraceView>;
  /** One artifact of a run. */
  getArtifact: RouteShape<ArtifactParams, undefined, ArtifactView>;
  /** Improvement proposals waiting for a decision. */
  listProposals: RouteShape<WorkspaceParams, undefined, ProposalView[]>;
  /** One proposal with its evidence. */
  getProposal: RouteShape<ProposalParams, undefined, ProposalView>;
  /** Approves a proposal at its first or second step. */
  approveProposal: RouteShape<ProposalParams, ApproveProposalBody, ProposalView>;
  /** Rejects a proposal. */
  rejectProposal: RouteShape<ProposalParams, RejectProposalBody, ProposalView>;
  /** Launches an improve run for a page. */
  startImproveRun: RouteShape<PageParams, WriteBody, StartRunResult>;
}

/** The name of a route. */
export type WorkspaceRouteName = keyof WorkspaceRouteTypes;

/** The routes that answer with one JSON document. */
export type JsonRouteName = Exclude<WorkspaceRouteName, 'streamRunEvents'>;

/** What a route does: `read` changes nothing, `write` changes a workspace and needs `expectedRevision`, `draft` changes only a draft, `run` starts or steers a run. */
export type RouteEffect = 'read' | 'write' | 'draft' | 'run';

/** One row of {@link WORKSPACE_ROUTES}. */
export interface WorkspaceRoute<Name extends WorkspaceRouteName> {
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path with `:name` segments. */
  path: string;
  /** What the route does. */
  effect: RouteEffect;
  /** True for the SSE route. */
  stream?: true;
  /** Validates the request body; absent when the route takes none. */
  body?: z.ZodType<WorkspaceRouteTypes[Name]['body']>;
  /** Validates the response, or for a stream one event. */
  response: z.ZodType<WorkspaceRouteTypes[Name]['response']>;
}

/** The route table type. */
export type WorkspaceRouteTable = { [Name in WorkspaceRouteName]: WorkspaceRoute<Name> };

const BASE = '/api/workspaces';
const WS = `${BASE}/:id`;
const PAGE = `${WS}/pages/:page`;
const RUN = `${WS}/runs/:runId`;
const DRAFT = `${WS}/drafts/:draftId`;
const PROPOSAL = `${WS}/proposals/:proposalId`;

const listOf = <T>(item: z.ZodType<T>): z.ZodType<T[]> => z.array(item);

/** Every route of the workspace service: method, path, effect and the schemas that check its body and response. */
export const WORKSPACE_ROUTES: WorkspaceRouteTable = {
  listWorkspaces: { method: 'GET', path: BASE, effect: 'read', response: workspaceSummariesSchema },
  getWorkspace: { method: 'GET', path: WS, effect: 'read', response: workspaceDetailSchema },
  listPages: { method: 'GET', path: `${WS}/pages`, effect: 'read', response: listOf(pageDetailSchema) },
  getPage: { method: 'GET', path: PAGE, effect: 'read', response: pageDetailSchema },
  getEffectiveHarness: { method: 'GET', path: `${PAGE}/harness/effective`, effect: 'read', response: harnessViewSchema },
  getMainHarness: { method: 'GET', path: `${WS}/main-harness`, effect: 'read', response: mainHarnessViewSchema },
  getAttachments: { method: 'GET', path: `${PAGE}/attachments`, effect: 'read', response: listOf(attachmentViewSchema) },
  getPageUi: { method: 'GET', path: `${PAGE}/ui`, effect: 'read', response: pageUiViewSchema },
  getProblems: { method: 'GET', path: `${WS}/problems`, effect: 'read', response: listOf(problemViewSchema) },
  getHistory: { method: 'GET', path: `${WS}/history`, effect: 'read', response: listOf(historyEntrySchema) },
  setPolicy: { method: 'PUT', path: `${WS}/policy`, effect: 'write', body: setPolicyBodySchema, response: writeResultSchema },
  writeSharedFile: { method: 'PUT', path: `${WS}/shared`, effect: 'write', body: writeSharedFileBodySchema, response: writeResultSchema },
  writeProfile: { method: 'PUT', path: `${WS}/profiles/:profile`, effect: 'write', body: writeProfileBodySchema, response: writeResultSchema },
  applyOps: { method: 'POST', path: `${WS}/ops`, effect: 'write', body: applyOpsBodySchema, response: applyOpsViewSchema },
  listDrafts: { method: 'GET', path: `${WS}/drafts`, effect: 'read', response: listOf(draftViewSchema) },
  getDraft: { method: 'GET', path: DRAFT, effect: 'read', response: draftViewSchema },
  applyDraft: { method: 'POST', path: `${DRAFT}/apply`, effect: 'write', body: writeBodySchema, response: writeResultSchema },
  rebaseDraft: { method: 'POST', path: `${DRAFT}/rebase`, effect: 'draft', response: draftViewSchema },
  discardDraft: { method: 'POST', path: `${DRAFT}/discard`, effect: 'draft', response: writeResultSchema },
  startPageRun: { method: 'POST', path: `${PAGE}/runs`, effect: 'run', body: startPageRunBodySchema, response: startRunResultSchema },
  startWorkspaceRun: { method: 'POST', path: `${WS}/runs`, effect: 'run', body: startWorkspaceRunBodySchema, response: startRunResultSchema },
  streamRunEvents: { method: 'GET', path: `${RUN}/events`, effect: 'read', stream: true, response: wireRunEventSchema },
  cancelRun: { method: 'POST', path: `${RUN}/cancel`, effect: 'run', response: pageRunViewSchema },
  approveRun: { method: 'POST', path: `${RUN}/approve`, effect: 'run', body: approveRunBodySchema, response: pageRunViewSchema },
  getRun: { method: 'GET', path: RUN, effect: 'read', response: pageRunViewSchema },
  getRunTrace: { method: 'GET', path: `${RUN}/trace`, effect: 'read', response: runTraceViewSchema },
  getArtifact: { method: 'GET', path: `${WS}/artifacts/:runId/:name`, effect: 'read', response: artifactViewSchema },
  listProposals: { method: 'GET', path: `${WS}/proposals`, effect: 'read', response: listOf(proposalViewSchema) },
  getProposal: { method: 'GET', path: PROPOSAL, effect: 'read', response: proposalViewSchema },
  approveProposal: { method: 'POST', path: `${PROPOSAL}/approve`, effect: 'write', body: approveProposalBodySchema, response: proposalViewSchema },
  rejectProposal: { method: 'POST', path: `${PROPOSAL}/reject`, effect: 'write', body: rejectProposalBodySchema, response: proposalViewSchema },
  startImproveRun: { method: 'POST', path: `${PAGE}/improve`, effect: 'write', body: writeBodySchema, response: startRunResultSchema },
};

/** The name of every route, in table order. */
export const ROUTE_NAMES: readonly WorkspaceRouteName[] = Object.keys(WORKSPACE_ROUTES) as WorkspaceRouteName[];

/** Fills the `:name` segments of a route path, encoding each value. */
export function buildRoutePath(path: string, params: object): string {
  const values = params as Readonly<Record<string, string | undefined>>;
  return path.replace(/:([A-Za-z]+)/g, (_match, key: string) => encodeURIComponent(values[key] ?? ''));
}
