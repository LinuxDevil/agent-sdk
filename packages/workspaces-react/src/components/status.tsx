import type { ReactElement } from 'react';
import type { UiRunWidget } from 'lousho/workspaces/client';
import type { RenderContext, RunPhase } from '../context';

const STATUS_WORDS: Readonly<Record<RunPhase, string>> = {
  idle: 'Ready',
  starting: 'Starting',
  queued: 'Queued',
  running: 'Running',
  'needs-approval': 'Waiting for approval',
  ok: 'Done',
  failed: 'Failed',
  'timed-out': 'Timed out',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function RunStatus({ node, ctx }: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  const word = STATUS_WORDS[ctx.run.status];
  return (
    <div className="lwr-status">
      <p role="status" aria-live="polite">
        {node.label === undefined ? word : `${node.label}: ${word}`}
      </p>
      {ctx.run.error !== undefined && <p className="lwr-error" role="alert">{ctx.run.error}</p>}
    </div>
  );
}

export function Progress({ node, ctx }: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  const progress = ctx.run.progress;
  return (
    <div className="lwr-progress">
      {progress?.fraction !== undefined && <progress max={1} value={progress.fraction} aria-label={node.label ?? 'Progress'} />}
      <p className="lwr-note">{progress?.message ?? ''}</p>
    </div>
  );
}

export function TraceLink({ ctx }: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  const traceId = ctx.run.view?.result?.traceId;
  return <p className="lwr-note">{traceId === undefined ? 'No trace yet' : `Trace ${traceId}`}</p>;
}

export function VersionsLater(_props: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  return <p className="lwr-note">Versions are not available in this version.</p>;
}
