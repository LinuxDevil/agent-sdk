import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AuthorSessionSummary } from '../../shared/authorWire';
import { fmtAge } from '../observe/format';
import { runtimeClient, RuntimeApiError } from '../runtime/runtimeClient';
import { useAppState } from '../state/AppState';
import { ConfirmDialog } from '../ui/Dialog';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { useAuthorChat } from './AuthorChatContext';
import { ErrorNote } from './ErrorNote';

/** The three states the list area renders: shimmer, the error note with retry, or the rows. */
type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; sessions: AuthorSessionSummary[] };

/** Why a row's actions are off right now; `undefined` means both are clickable. */
function busyReason(chat: ReturnType<typeof useAuthorChat>): string | undefined {
  if (chat.state.saving !== null) return 'Wait for the save to finish';
  if (chat.isStreaming) return 'Wait for the Author to finish replying';
  return undefined;
}

/**
 * The History view that swaps in for the conversation log (PLAN §11 Author
 * dock header): every earlier Author chat newest first - title, focus,
 * relative time and counts - opening one or deleting it behind a confirm.
 * Mounted only while open, so every History-button click reloads the list.
 */
export function AuthorHistory({ onClose }: { onClose(): void }): JSX.Element {
  const chat = useAuthorChat();
  const { agents } = useAppState();
  const toast = useToast();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [pendingDelete, setPendingDelete] = useState<AuthorSessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  /** An agent's display name from the app's already-loaded list; an unknown id shows itself. */
  const agentName = useCallback((id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);

  const reload = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      const sessions = await runtimeClient.listAuthorSessions();
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setLoad({ status: 'ready', sessions });
    } catch {
      setLoad({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** `Editing <name>` or `New agent` · relative time · counts · what the chat produced. */
  function meta(s: AuthorSessionSummary): string {
    const focus = s.focus.mode === 'edit' ? `Editing ${agentName(s.focus.agentId)}` : 'New agent';
    const when = fmtAge(Date.now() - new Date(s.updatedAt).getTime());
    const count = `${s.messageCount} ${s.messageCount === 1 ? 'message' : 'messages'}`;
    const created =
      s.createdAgentIds.length > 0 ? ` · created ${s.createdAgentIds.map(agentName).join(', ')}` : '';
    return `${focus} · ${when} · ${count}${created}`;
  }

  async function openSession(s: AuthorSessionSummary): Promise<void> {
    try {
      await chat.openSession(s.id);
      onClose();
    } catch {
      // The row outlived its chat; reload so the list shows the store's truth.
      await reload();
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    if (target === null || deleting) return;
    setDeleting(true);
    try {
      await runtimeClient.deleteAuthorSession(target.id);
      setPendingDelete(null);
      if (load.status === 'ready') {
        setLoad({ status: 'ready', sessions: load.sessions.filter((s) => s.id !== target.id) });
      }
      toast.show({ message: 'Chat deleted', tone: 'success' });
      if (chat.state.sessionId === target.id) chat.newChat();
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 409) {
        setPendingDelete(null);
        toast.show({ message: 'Stop the reply before deleting this chat.', tone: 'warning' });
      } else {
        setDeleteError("Couldn't delete this chat. Try again.");
      }
    } finally {
      setDeleting(false);
    }
  }

  const busy = busyReason(chat);

  return (
    <section className="author-history" aria-label="Chat history">
      <header className="author-history-head">
        <h3 className="author-history-title">History</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Back to chat
        </button>
      </header>
      {load.status === 'loading' && <SkeletonRows rows={4} />}
      {load.status === 'error' && (
        <ErrorNote message="Couldn't load your chats." action={{ label: 'Try again', onClick: () => void reload() }} />
      )}
      {load.status === 'ready' && load.sessions.length === 0 && (
        <EmptyState title="No earlier chats" hint="Chats you have with the Author show up here." />
      )}
      {load.status === 'ready' && load.sessions.length > 0 && (
        <ul className="author-history-list" role="list">
          {load.sessions.map((s) => {
            const current = s.id === chat.state.sessionId;
            return (
              <li key={s.id} className="author-history-item" data-current={current}>
                <button
                  type="button"
                  className="author-history-open"
                  disabled={current || busy !== undefined}
                  title={current ? 'This chat is open' : busy}
                  onClick={() => void openSession(s)}
                >
                  <span className="author-history-name">{s.title}</span>
                  <span className="author-history-meta">{meta(s)}</span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete chat “${s.title}”`}
                  title={busy}
                  disabled={busy !== undefined}
                  onClick={() => {
                    setDeleteError(undefined);
                    setPendingDelete(s);
                  }}
                >
                  <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this chat?"
        description={
          pendingDelete === null
            ? ''
            : `“${pendingDelete.title}” will be removed from History. Agents it created are kept.`
        }
        confirmLabel="Delete chat"
        pendingLabel="Deleting…"
        pending={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
