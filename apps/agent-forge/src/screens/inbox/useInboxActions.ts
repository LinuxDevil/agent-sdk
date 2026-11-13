import { useCallback, useState } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useSuggestFix } from '../../state/useSuggestFix';
import { useToast } from '../../ui/Toast';
import type { InboxItem } from '../../../shared/wireTypes';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

/** Re-inserts `item` at `index` unless it is already back or the list is gone. */
function restoreItem(items: InboxItem[] | null, index: number, item: InboxItem): InboxItem[] | null {
  if (items === null || index < 0 || items.some((entry) => entry.id === item.id)) return items;
  const next = [...items];
  next.splice(Math.min(index, next.length), 0, item);
  return next;
}

/**
 * The inbox row actions (R02b): each one optimistically drops its row,
 * toasts the outcome, and on failure restores the row at its old index.
 * `acting` marks the rows with a request in flight so the row can disable
 * its buttons.
 */
export function useInboxActions(items: InboxItem[] | null, setItems: (updater: (prev: InboxItem[] | null) => InboxItem[] | null) => void) {
  const [acting, setActing] = useState<ReadonlySet<string>>(new Set());
  const toast = useToast();
  const suggestFix = useSuggestFix();

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
        setItems((prev) => restoreItem(prev, index, item));
      } finally {
        setActing((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [items, setItems, toast],
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

  /** Marks `item` acting for the duration of `run`; failures toast `errorMessage`. The row is never dropped. */
  const withActing = useCallback(
    async (item: InboxItem, run: () => Promise<unknown>) => {
      setActing((prev) => new Set(prev).add(item.id));
      try {
        await run();
      } catch (cause) {
        toast.show({ message: errorMessage(cause), tone: 'error' });
      } finally {
        setActing((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [toast],
  );

  /** Low-rating alerts (R04b): seeds the trace into `<agentId>-regressions`; the row stays until dismissed. */
  const onAddToDataset = useCallback(
    (item: InboxItem & { kind: 'alert' }) =>
      void withActing(item, async () => {
        const { dataset } = await runtimeClient.addAlertToDataset(item.agentId, item.alertId);
        toast.show({
          message: `Added to ${dataset}`,
          tone: 'success',
          action: {
            label: 'Open dataset',
            onClick: () => {
              window.location.hash = `#/evals/datasets/${encodeURIComponent(dataset)}`;
            },
          },
        });
      }),
    [toast, withActing],
  );

  /**
   * Low-rating alerts (R06): "Suggest a fix" starts the prompt-suggestion
   * pass on the alert's trace, then opens the Suggestions tab (the shared
   * `useSuggestFix` navigates with `?suggesting=<id>`). The row stays put -
   * success navigates away, failure toasts and leaves it.
   */
  const onSuggestFix = useCallback(
    (item: InboxItem & { kind: 'alert' }) => {
      const traceId = item.payload.traceId;
      if (typeof traceId !== 'string' || traceId === '') return;
      return withActing(item, () => suggestFix(item.agentId, traceId));
    },
    [suggestFix, withActing],
  );

  return { acting, onApprove, onAnswer, onDismiss, onAddToDataset, onSuggestFix };
}
