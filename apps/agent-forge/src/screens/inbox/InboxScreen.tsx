import { Inbox } from 'lucide-react';

import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { ScreenHeader } from '../../shell/ScreenHeader';
import type { InboxItem, InboxItemKind } from '../../../shared/wireTypes';
import { InboxRow } from './InboxRow';
import { useInboxActions } from './useInboxActions';
import { useInboxData } from './useInboxData';
import './inbox.css';

const GROUPS: readonly { kind: InboxItemKind; title: string }[] = [
  { kind: 'approval', title: 'Approvals' },
  { kind: 'question', title: 'Questions' },
  { kind: 'draft', title: 'Drafts' },
  { kind: 'suggestion', title: 'Suggestions' },
  { kind: 'alert', title: 'Alerts' },
];

function InboxHeader({ onRefresh }: { onRefresh: () => void }) {
  return (
    <ScreenHeader
      title="Inbox"
      description="Approvals, questions and changes waiting on you."
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

interface InboxGroupsProps {
  items: InboxItem[];
  acting: ReadonlySet<string>;
  now: number;
  onApprove: (item: InboxItem & { kind: 'approval' }, approved: boolean) => void;
  onAnswer: (item: InboxItem & { kind: 'question' }, answer: string) => void;
  onDismiss: (item: InboxItem & { kind: 'alert' }) => void;
}

function InboxGroups({ items, acting, now, onApprove, onAnswer, onDismiss }: InboxGroupsProps) {
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
                  key={item.id}
                  item={item}
                  acting={acting.has(item.id)}
                  now={now}
                  onApprove={onApprove}
                  onAnswer={onAnswer}
                  onDismiss={onDismiss}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function InboxBody({ data }: { data: ReturnType<typeof useInboxData> }) {
  const { items, setItems, state, error, now, refresh } = data;
  const { acting, onApprove, onAnswer, onDismiss } = useInboxActions(items, setItems);
  const header = <InboxHeader onRefresh={() => void refresh()} />;

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
      <InboxGroups items={items} acting={acting} now={now} onApprove={onApprove} onAnswer={onAnswer} onDismiss={onDismiss} />
    </>
  );
}

/**
 * `#/inbox` (R02b): everything waiting on the user across the workspace's
 * agents, grouped by kind with the actions in the row. The list refetches
 * on mount, on Refresh, and on every `inbox.count` event - the badge and
 * this screen stay in step without polling.
 */
export function InboxScreen() {
  const data = useInboxData();
  return (
    <section className="inbox-screen" aria-label="Inbox">
      <InboxBody data={data} />
    </section>
  );
}
