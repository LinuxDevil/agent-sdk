/**
 * Settings → Workspaces card (W05b): every registered workspace with its
 * folder, agent count and state pill, plus per-row Rescan (code agents,
 * W08a's `POST /workspaces/:ws/scan`) and Remove (U04 ConfirmDialog;
 * removes the registry entry only - the folder on disk is never touched),
 * and an "Add workspace" button reusing W05a's dialog.
 *
 * Screen variant only (`SettingsPanel` renders it after Appearance). The
 * launch workspace cannot be removed while Studio runs, and a missing
 * folder cannot be rescanned - both stay listed with the reason as the
 * disabled control's `title`.
 */
import { useState } from 'react';
import { Folders, RefreshCw, Trash2 } from 'lucide-react';

import type { WorkspaceListItem } from '../../shared/wireTypes';
import { runtimeClient } from '../runtime/runtimeClient';
import { navigate } from '../router/router';
import { useToast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/Dialog';
import { Skeleton } from '../ui/Skeleton';
import { AddWorkspaceDialog } from '../workspace/AddWorkspaceDialog';
import { useWorkspacesMaybe } from '../workspace/WorkspacesProvider';
import { workspaceFromHash } from '../workspace/activeWorkspace';
import { SettingsCard, TonePill } from './SettingsCard';
import './settingsWorkspaces.css';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The load failure: the message plus a Retry that re-runs `refresh()`. */
function LoadError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="run-error" role="alert">
      {message}{' '}
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** One workspace row: name, folder, agent count + state pill, Rescan and Remove. */
function WorkspaceRow({
  ws,
  onRescan,
  rescanning,
  onRemove,
}: {
  ws: WorkspaceListItem;
  onRescan(ws: WorkspaceListItem): void;
  rescanning: boolean;
  onRemove(ws: WorkspaceListItem): void;
}) {
  return (
    <li className="settings-workspace">
      <div className="settings-workspace-text">
        <span className="settings-workspace-name">{ws.name}</span>
        <code className="settings-workspace-root">{ws.root}</code>
        <span className="settings-workspace-meta">
          {ws.agentCount} {ws.agentCount === 1 ? 'agent' : 'agents'}
          {ws.isLaunch && <TonePill tone="info" label="Started here" />}
          {!ws.available && <TonePill tone="error" label="Folder missing" />}
        </span>
      </div>
      <div className="settings-workspace-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onRescan(ws)}
          disabled={!ws.available || rescanning}
          title={ws.available ? undefined : 'This folder is missing.'}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {rescanning ? 'Scanning…' : 'Rescan'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onRemove(ws)}
          disabled={ws.isLaunch}
          title={
            ws.isLaunch
              ? 'Studio was started in this folder, so it stays in the list while Studio runs.'
              : undefined
          }
        >
          <Trash2 size={14} aria-hidden="true" />
          Remove
        </button>
      </div>
    </li>
  );
}

/**
 * The card. Data comes from `useWorkspacesMaybe()` (the app's one
 * `GET /workspaces` load); `undefined` outside the provider renders the
 * loading rows, an `error` the retry row.
 */
export function WorkspacesSection(): JSX.Element {
  const state = useWorkspacesMaybe();
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<WorkspaceListItem | undefined>(undefined);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const [rescanningId, setRescanningId] = useState<string | undefined>(undefined);

  const workspaces = state?.list;
  const refresh = state?.refresh;

  const rescan = async (ws: WorkspaceListItem) => {
    setRescanningId(ws.id);
    try {
      const result = await runtimeClient.scanWorkspace(ws.id);
      const n = result.agents.length;
      toast.show({
        message: `Found ${n} code agent${n === 1 ? '' : 's'} in ${ws.name}.`,
        tone: 'success',
      });
    } catch (error) {
      toast.show({ message: messageOf(error), tone: 'error' });
    } finally {
      setRescanningId(undefined);
    }
  };

  const confirmRemove = async () => {
    if (removing === undefined) return;
    setRemovePending(true);
    setRemoveError(undefined);
    try {
      await runtimeClient.removeWorkspace(removing.id);
      setRemoving(undefined);
      await refresh?.();
      toast.show({ message: `Removed “${removing.name}”.`, tone: 'success' });
      // Removing the workspace the URL is inside leaves it dangling:
      // land on the all-workspaces list.
      if (workspaceFromHash(window.location.hash) === removing.id) navigate('/agents');
    } catch (error) {
      setRemoveError(messageOf(error));
    } finally {
      setRemovePending(false);
    }
  };

  return (
    <SettingsCard
      Icon={Folders}
      title="Workspaces"
      description="Project folders Studio shows agents from."
      id="settings-workspaces"
    >
      {state?.error !== undefined ? (
        <LoadError message={state.error} onRetry={() => void refresh?.()} />
      ) : workspaces === undefined ? (
        <ul className="settings-workspaces" aria-label="Workspaces" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="settings-workspace settings-workspace-skeleton">
              <Skeleton width="55%" height={14} />
              <Skeleton width="80%" height={12} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="settings-workspaces">
          {workspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              ws={ws}
              rescanning={rescanningId === ws.id}
              onRescan={(w) => void rescan(w)}
              onRemove={(w) => {
                setRemoveError(undefined);
                setRemoving(w);
              }}
            />
          ))}
        </ul>
      )}
      <div className="settings-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>
          Add workspace
        </button>
      </div>
      <AddWorkspaceDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(item) => {
          void refresh?.();
          toast.show({ message: `Added “${item.name}”.`, tone: 'success' });
        }}
      />
      <ConfirmDialog
        open={removing !== undefined}
        title={removing === undefined ? '' : `Remove “${removing.name}” from Studio?`}
        description="Studio stops showing its agents. Nothing in the folder is deleted, and you can add it again later."
        confirmLabel="Remove workspace"
        pendingLabel="Removing…"
        pending={removePending}
        error={removeError}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoving(undefined)}
      />
    </SettingsCard>
  );
}
