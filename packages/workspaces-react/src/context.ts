import type { Key, ReactElement } from 'react';
import type { ApiClient, ArtifactRef, PageApprovalEvent, PageProgressEvent, PageRunView, PageUi, RunViewStatus, UiComponent } from '@linuxdevil/lousho/workspaces/client';

/** Where a run started from the page UI stands: `idle` before the first run, `starting` until the service answers, then the service's status. */
export type RunPhase = 'idle' | 'starting' | RunViewStatus;

/** What the run button hands {@link RunHandle.start}. */
export interface RunStartInput {
  /** The task, in words. */
  task: string;
  /** The form's values: the page's structured inputs. */
  inputs: Record<string, unknown>;
}

/** The run state and controls a page UI shows. */
export interface RunHandle {
  /** Whether a run can start. */
  available: boolean;
  /** Where the run stands. */
  status: RunPhase;
  /** The current run. */
  runId?: string;
  /** The run as the service last reported it, with its result once it ended or paused. */
  view?: PageRunView;
  /** Artifacts the run produced so far. */
  artifacts: ArtifactRef[];
  /** The last progress note. */
  progress?: PageProgressEvent;
  /** The approval the run waits on. */
  approval?: PageApprovalEvent;
  /** What went wrong, for people. */
  error?: string;
  /** Starts a run. */
  start(input: RunStartInput): Promise<void>;
  /** Cancels the current run. */
  cancel(): Promise<void>;
  /** Answers the approval the run waits on. */
  approve(decision: 'approve' | 'deny', answer?: string): Promise<void>;
}

export interface FormState {
  values: Record<string, unknown>;
  errors: Readonly<Record<string, string>>;
  get(bind: string): unknown;
  set(bind: string, value: unknown): void;
  validate(): string[];
}

export interface RenderContext {
  client: ApiClient;
  workspaceId: string;
  pageId: string;
  ui: PageUi;
  inputsSchema?: Record<string, unknown>;
  form: FormState;
  run: RunHandle;
  task: string;
  render(node: UiComponent, key: Key): ReactElement;
}

const settled = (): Promise<void> => Promise.resolve();

export const IDLE_RUN: RunHandle = { available: false, status: 'idle', artifacts: [], start: settled, cancel: settled, approve: settled };
