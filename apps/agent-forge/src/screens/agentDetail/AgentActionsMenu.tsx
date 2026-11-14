import { useState } from 'react';
import { Copy, FileDown, Sparkles, Trash2 } from 'lucide-react';

import { openAuthor } from '../../author/authorEntry';
import type { AgentRecord } from '../../../shared/wireTypes';
import { navigate } from '../../router/router';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useAppState } from '../../state/AppState';
import { errorMessage } from '../../components/errorMessage';
import { ConfirmDialog } from '../../ui/Dialog';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { useToast } from '../../ui/Toast';
import { agentListPath, agentTabPath } from '../agents/agentTabs';
import { activeWorkspace } from '../../workspace/activeWorkspace';
import { ExportSheet } from './export/ExportSheet';

/**
 * The detail header's overflow menu (PLAN §11, A12): Change with AI (AA19's
 * Author entry point focused on this agent), Duplicate (a
 * `POST /agents { from: { copyOf } }` copy that opens its canvas), Export…
 * (L09b's export sheet: format pick, portability check, adapted download)
 * and Delete agent… behind a ConfirmDialog. Passed to `AgentDetailHeader`'s
 * `menu` prop by `AgentDetailRoute`.
 */
export function AgentActionsMenu({ record }: { record: AgentRecord }): JSX.Element {
  const { id, spec } = record;
  const toast = useToast();
  const { agentId, switchAgent } = useAppState();
  const [duplicating, setDuplicating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  /** The reason every item is off while an action is in flight; `undefined` when idle. */
  const busyReason = duplicating ? 'Duplicating…' : deleting ? 'Deleting…' : undefined;

  async function duplicate(): Promise<void> {
    setDuplicating(true);
    try {
      const copy = await runtimeClient.duplicateAgent(id);
      toast.show({
        message: `Made a copy: ${copy.spec.name}. It is off until you turn it on.`,
        tone: 'success',
      });
      navigate(agentTabPath(copy.id, 'canvas'));
    } catch (error) {
      toast.show({ message: `Couldn't duplicate: ${errorMessage(error)}`, tone: 'error' });
    } finally {
      setDuplicating(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await runtimeClient.deleteAgent(id);
      // The builder must not keep the deleted agent open; 'untitled-agent' is the document's fresh default.
      if (agentId === id) await switchAgent('untitled-agent');
      // Navigate before the toast so the detail screen unmounts without refetching the deleted record.
      navigate(agentListPath(activeWorkspace()));
      toast.show({ message: 'Agent deleted', tone: 'success' });
      setConfirmOpen(false);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  const items: MenuEntry[] = [
    {
      id: 'change-with-ai',
      label: 'Change with AI',
      icon: Sparkles,
      disabled: busyReason !== undefined,
      disabledReason: busyReason,
      onSelect: () => openAuthor({ source: 'agent-header', focus: { mode: 'edit', agentId: id } }),
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      icon: Copy,
      disabled: busyReason !== undefined,
      disabledReason: busyReason,
      onSelect: () => void duplicate(),
    },
    {
      id: 'export',
      label: 'Export…',
      icon: FileDown,
      disabled: busyReason !== undefined,
      disabledReason: busyReason,
      onSelect: () => setExportOpen(true),
    },
    { id: 'sep-actions', separator: true },
    {
      id: 'delete',
      label: 'Delete agent…',
      icon: Trash2,
      tone: 'danger',
      disabled: busyReason !== undefined,
      disabledReason: busyReason,
      onSelect: () => {
        setDeleteError(undefined);
        setConfirmOpen(true);
      },
    },
  ];

  return (
    <>
      <Menu label="More actions" items={items} />
      <ExportSheet
        agentId={id}
        agentName={spec.name}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
      />
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete “${spec.name}”?`}
        description={`This removes .lousho/agents/${id}.yaml and its versions, drafts and layout. Runs already sent to the observe daemon stay. This can’t be undone.`}
        confirmLabel="Delete agent"
        pendingLabel="Deleting…"
        pending={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
