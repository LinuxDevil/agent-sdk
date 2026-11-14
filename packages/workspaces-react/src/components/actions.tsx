import type { ReactElement } from 'react';
import type { UiRunWidget } from '@linuxdevil/lousho/workspaces/client';
import type { RenderContext, RunPhase } from '../context';

const BUSY: ReadonlySet<RunPhase> = new Set<RunPhase>(['starting', 'queued', 'running', 'needs-approval']);

export function isBusy(status: RunPhase): boolean {
  return BUSY.has(status);
}

export function RunButton({ node, ctx }: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  const onClick = (): void => {
    if (ctx.form.validate().length === 0) void ctx.run.start({ task: ctx.task, inputs: ctx.form.values });
  };
  return (
    <button type="button" className="lwr-button lwr-primary" disabled={!ctx.run.available || isBusy(ctx.run.status)} onClick={onClick}>
      {node.label ?? 'Generate'}
    </button>
  );
}

export function CancelButton({ node, ctx }: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  return (
    <button type="button" className="lwr-button" disabled={!isBusy(ctx.run.status)} onClick={() => void ctx.run.cancel()}>
      {node.label ?? 'Cancel'}
    </button>
  );
}

export function ReviseBox(_props: { node: UiRunWidget; ctx: RenderContext }): ReactElement {
  return <p className="lwr-note">Ask for a revision in the workspace chat.</p>;
}
