import { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useStudioEvents } from '../../state/useStudioEvents';
import { useToast } from '../../ui/Toast';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { ScreenHeader } from '../../shell/ScreenHeader';
import type { InboxItem, InboxItemKind, StudioEvent } from '../../../shared/wireTypes';
import { InboxRow } from './InboxRow';
import './inbox.css';

type LoadState = 'loading' | 'ready' | 'error';

const GROUPS: readonly { kind: InboxItemKind; title: string }[] = [
  { kind: 'approval', title: 'Approvals' },
  { kind: 'question', title: 'Questions' },
  { kind: 'draft', title: 'Drafts' },
  { kind: 'suggestion', title: 'Suggestions' },
  { kind: 'alert', title: 'Alerts' },
];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

/**
 * `#/inbox` (R02b): everything waiting on the user across the workspace's
 * agents, grouped by kind with the actions in the row. The list refetches
 * on mount, on Refresh, and on every `inbox.count` event - the badge and
 * this screen stay in step without polling.
 */
export function InboxScreen() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [acting, setActing] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const toast = useToast();
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const list = await runtimeClient.listInbox();
      if (request !== requestRef.current) return;
      setItems(list);
      setState('ready');
      setError('');
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(errorMessage(cause));
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (event.type === 'inbox.count') void load();
      },
      [load],
    ),
  );

  // One shared clock for every deadline on the page; only ticks while a
  // deadline-bearing row is on screen.
  const hasDeadlines = items?.some((item) => (item.kind === 'approval' || item.kind === 'question') && item.expiresAt !== null) ?? false;
  useEffect(() => {
    if (!hasDeadlines) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasDeadlines]);

  /** Optimistically drops the row; a failure toasts the server message and restores it. */
  const act = useCallback(
    async (item: InboxItem, message: string, run: () => Promise<unknown>) => {
      const index = items?.findIndex((entry) => entry.id === item.id) ?? -1;
      setActing((prev) => new Set(prev).add(item.id));
      setItems((prev) => prev?.filter((entry) => entry.id !== item.id) ?? prev);
      try {
        await run();
        toast.show({ message, tone: 'success' });
      } catch (cause) {
        toast.show({ message: errorMessage(cause), tone: 'error' });
        setItems((prev) => {
          if (prev === null || index < 0 || prev.some((entry) => entry.id === item.id)) return prev;
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, item);
          return next;
        });
      } finally {
        setActing((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [items, toast],
  );

  const onApprove = useCallback(
    (item: InboxItem & { kind: 'approval' }, approved: boolean) =>
      void act(item, approved ? 'Approved' : 'Denied', () => runtimeClient.approve(item.agentId, item.approvalId, approved)),
    [act],
  );
  const onAnswer = useCallback(
    (item: InboxItem & { kind: 'question' }, answer: string) =>
      void act(item, 'Answer sent', () => runtimeClient.answer(item.agentId, item.approvalId, answer)),
    [act],
  );
  const onDismiss = useCallback(
    (item: InboxItem & { kind: 'alert' }) => void act(item, 'Dismissed', () => runtimeClient.dismissAlert(item.alertId)),
    [act],
  );

  const header = (
    <ScreenHeader
      title="Inbox"
      description="Approvals, questions and changes waiting on you."
      actions={
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          Refresh
        </button>
      }
    />
  );

  if (state === 'loading') {
    return (
      <section className="inbox-screen" aria-label="Inbox">
        {header}
        <SkeletonRows rows={4} />
      </section>
    );
  }
  if (state === 'error') {
    return (
      <section className="inbox-screen" aria-label="Inbox">
        {header}
        <EmptyState
          title="Couldn't load the inbox"
          hint={error}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              Retry
            </button>
          }
        />
      </section>
    );
  }
  if (items === null || items.length === 0) {
    return (
      <section className="inbox-screen" aria-label="Inbox">
        {header}
        <EmptyState title="Nothing needs you" hint="Approvals, questions and suggested changes from your agents show up here." icon={Inbox} />
      </section>
    );
  }

  return (
    <section className="inbox-screen" aria-label="Inbox">
      {header}
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
    </section>
  );
}
