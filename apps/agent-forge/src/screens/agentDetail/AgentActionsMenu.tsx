import { useState } from 'react';
import { Copy, Download, Trash2 } from 'lucide-react';

import type { AgentRecord } from '../../../shared/wireTypes';
import { navigate } from '../../router/router';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useAppState } from '../../state/AppState';
import { errorMessage } from '../../components/errorMessage';
import { downloadYaml } from '../../persistence/importExport';
import { ConfirmDialog } from '../../ui/Dialog';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { useToast } from '../../ui/Toast';
import { agentTabPath } from '../agents/agentTabs';

/**
 * The detail header's overflow menu (PLAN §11, A12): Duplicate (a
 * `POST /agents { from: { copyOf } }` copy that opens its Overview), Export
 * YAML (a client-side `<a download>` of the spec until L07's export sheet)
 * and Delete agent… behind a ConfirmDialog. Passed to `AgentDetailHeader`'s
 * `menu` prop by `AgentDetailRoute`.
 */
export function AgentActionsMenu({ record }: { record: AgentRecord }): JSX.Element {
  const { id, spec } = record;
  const toast = useToast();
  const { agentId, switchAgent } = useAppState();
  const [duplicating, setDuplicating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  /** The reason every item is off while an action is in flight; `undefined` when idle. */
  const busyReason = duplicating ? 'Duplicating…' : deleting ? 'Deleting…' : undefined;

  async function duplicate(): Promise<void> {
    setDuplicating(true);
    try {
      const copy = await runtimeClient.createAgentRecord({ from: { copyOf: id } });
      toast.show({ message: `Duplicated as “${copy.spec.name}”`, tone: 'success' });
      navigate(agentTabPath(copy.id, 'overview'));
    } catch (error) {
      toast.show({ message: errorMessage(error), tone: 'error' });
    } finally {
      setDuplicating(false);
    }
  }

  function exportYaml(): void {
    const filename = `${id}.yaml`;
    downloadYaml(spec, filename);
    toast.show({ message: `Exported ${filename}`, tone: 'success' });
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
      navigate('/agents');
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
      id: 'duplicate',
      label: 'Duplicate',
      icon: Copy,
      disabled: busyReason !== undefined,
      disabledReason: busyReason,
      onSelect: () => void duplicate(),
    },
    {
      id: 'export',
      label: 'Export YAML',
      icon: Download,
      disabled: busyReason !== undefined,
      disabledReason: busyReason,
      onSelect: exportYaml,
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
