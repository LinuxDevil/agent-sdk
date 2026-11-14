import { Inbox } from 'lucide-react';

import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { ScreenHeader } from '../../shell/ScreenHeader';
import { useWorkspacesMaybe } from '../../workspace/WorkspacesProvider';
import { workspaceLabel } from '../../workspace/workspaceLabels';
import type { InboxItem, InboxItemKind } from '../../../shared/wireTypes';
import { useRoute } from '../../router/useRoute';
import { InboxRow, type InboxActionHandlers } from './InboxRow';
import { inboxScopeFromHash, type InboxScope } from './inboxScope';
import { inboxRowKey, useInboxActions } from './useInboxActions';
import { useInboxData } from './useInboxData';
import './inbox.css';

const GROUPS: readonly { kind: InboxItemKind; title: string }[] = [
  { kind: 'approval', title: 'Approvals' },
  { kind: 'question', title: 'Questions' },
  { kind: 'draft', title: 'Drafts' },
  { kind: 'suggestion', title: 'Suggestions' },
  { kind: 'alert', title: 'Alerts' },
];

function InboxHeader({ scope, onRefresh }: { scope: InboxScope; onRefresh: () => void }) {
  const workspaces = useWorkspacesMaybe();
  const name = scope.kind === 'workspace' ? workspaceLabel(scope.workspaceId, workspaces?.list) : undefined;
  const description =
    scope.kind === 'all'
      ? 'Approvals, questions and changes waiting on you in every workspace.'
      : `Approvals, questions and changes waiting on you in ${name}.`;
  return (
    <ScreenHeader
      title="Inbox"
      description={description}
      actions={
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
          Refresh
        </button>
      }
    />
  );
}

function InboxErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <EmptyState
      title="Couldn't load the inbox"
      hint={error}
      action={
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Retry
        </button>
      }
    />
  );
}

function InboxEmpty() {
  return (
    <EmptyState title="Nothing needs you" hint="Approvals, questions and suggested changes from your agents show up here." icon={Inbox} />
  );
}

interface InboxGroupsProps extends InboxActionHandlers {
  items: InboxItem[];
  acting: ReadonlySet<string>;
  now: number;
  /** All-workspaces view only: resolves an item's `workspaceId` to its display name for the row chip. */
  workspaceName?: (id: string) => string;
}

function InboxGroups({ items, acting, now, workspaceName, onApprove, onAnswer, onDismiss, onAddToDataset, onSuggestFix }: InboxGroupsProps) {
  return (
    <div className="inbox">
      {GROUPS.map((group) => {
        const rows = items.filter((item) => item.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <section key={group.kind} className="inbox-group" aria-labelledby={`inbox-${group.kind}s`}>
            <h2 className="inbox-group-title" id={`inbox-${group.kind}s`}>
              {group.title} <span className="inbox-group-count">{rows.length}</span>
            </h2>
            <ul className="inbox-list">
              {rows.map((item) => (
                <InboxRow
                  key={inboxRowKey(item)}
                  item={item}
                  acting={acting.has(inboxRowKey(item))}
                  now={now}
                  workspaceName={workspaceName?.(item.workspaceId)}
                  onApprove={onApprove}
                  onAnswer={onAnswer}
                  onDismiss={onDismiss}
                  onAddToDataset={onAddToDataset}
                  onSuggestFix={onSuggestFix}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function InboxBody({ scope, data }: { scope: InboxScope; data: ReturnType<typeof useInboxData> }) {
  const { items, setItems, state, error, now, refresh } = data;
  const { acting, onApprove, onAnswer, onDismiss, onAddToDataset, onSuggestFix } = useInboxActions(items, setItems);
  const workspaces = useWorkspacesMaybe();
  const header = <InboxHeader scope={scope} onRefresh={() => void refresh()} />;
  // The all-workspaces rows carry a workspace chip; a scoped view's rows don't need one.
  const nameOf =
    scope.kind === 'all'
      ? (id: string) => workspaceLabel(id, workspaces?.list)
      : undefined;

  if (state === 'loading') {
    return (
      <>
        {header}
        <SkeletonRows rows={4} />
      </>
    );
  }
  if (state === 'error') {
    return (
      <>
        {header}
        <InboxErrorState error={error} onRetry={() => void refresh()} />
      </>
    );
  }
  if (items === null || items.length === 0) {
    return (
      <>
        {header}
        <InboxEmpty />
      </>
    );
  }
  return (
    <>
      {header}
      <InboxGroups items={items} acting={acting} now={now} workspaceName={nameOf} onApprove={onApprove} onAnswer={onAnswer} onDismiss={onDismiss} onAddToDataset={onAddToDataset} onSuggestFix={onSuggestFix} />
    </>
  );
}

/**
 * `#/inbox` (W09b): everything waiting on the user in EVERY workspace,
 * grouped by kind with a workspace chip per row; `#/w/<ws>/inbox` scopes
 * the same screen to one workspace. The list refetches on mount, on
 * Refresh, and on every `inbox.count` event - the badge and this screen
 * stay in step without polling.
 */
export function InboxScreen() {
  const route = useRoute();
  const scope = inboxScopeFromHash(`#${route.path}`);
  const data = useInboxData(scope);
  return (
    <section className="inbox-screen" aria-label="Inbox">
      <InboxBody scope={scope} data={data} />
    </section>
  );
}
