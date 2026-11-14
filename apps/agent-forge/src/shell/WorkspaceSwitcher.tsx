import { useState } from 'react';
import { Folder, FolderOpen, FolderPlus, Globe } from 'lucide-react';

import type { WorkspaceListItem } from '../../shared/wireTypes';
import { navigate } from '../router/router';
import { useRoute } from '../router/useRoute';
import { Menu, type MenuEntry } from '../ui/Menu';
import { useToast } from '../ui/Toast';
import { AddWorkspaceDialog } from '../workspace/AddWorkspaceDialog';
import { agentListPath } from '../screens/agents/agentTabs';
import { switcherSelection, workspaceLabel } from '../workspace/workspaceLabels';
import { useWorkspacesMaybe, type WorkspacesState } from '../workspace/WorkspacesProvider';

/**
 * The NavRail's workspace picker (W05a): a U10 `Menu` whose trigger names
 * the current selection - 'All workspaces' on unscoped routes, the
 * workspace's name on `#/w/<ws>/…`. Items: All workspaces, the registry
 * (checked on the current one, missing folders disabled with their
 * reason), a separator, and Add workspace… which opens the folder-path
 * dialog; a successful add refreshes the list, toasts and lands on the
 * new workspace's agents.
 *
 * Renders nothing without a `WorkspacesProvider` (isolated shell mounts);
 * the toast/dialog half lives in `SwitcherMenu` so `useToast` is only
 * called where both providers exist.
 */
export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }): JSX.Element | null {
  const workspaces = useWorkspacesMaybe();
  const { path } = useRoute();
  // Re-render on every route change so `checked` and the trigger follow the URL.
  const selection = switcherSelection(`#${path}`);
  if (workspaces === undefined) return null;
  return <SwitcherMenu collapsed={collapsed} workspaces={workspaces} selection={selection} />;
}

function SwitcherMenu({
  collapsed,
  workspaces,
  selection,
}: {
  collapsed: boolean;
  workspaces: WorkspacesState;
  selection: string | undefined;
}): JSX.Element {
  const { list, error, refresh } = workspaces;
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const current = workspaceLabel(selection, list);

  const onAdded = async (item: WorkspaceListItem) => {
    await refresh();
    toast.show({ tone: 'success', message: `Added “${item.name}”.` });
    navigate(agentListPath(item.id));
  };

  const items: MenuEntry[] = [];
  if (list !== undefined) {
    items.push(
      { id: 'all', label: 'All workspaces', icon: Globe, checked: selection === undefined, onSelect: () => navigate('/agents') },
      { id: 'h', heading: 'Workspaces' },
      ...list.map((ws) => ({
        id: ws.id,
        label: ws.name,
        icon: Folder,
        checked: selection === ws.id,
        disabled: !ws.available,
        disabledReason: 'This folder is missing. Check the path in Settings.',
        onSelect: () => navigate(agentListPath(ws.id)),
      })),
      { id: 's', separator: true },
      { id: 'add', label: 'Add workspace…', icon: FolderPlus, onSelect: () => setDialogOpen(true) },
    );
  } else {
    items.push({ id: 'add', label: 'Add workspace…', icon: FolderPlus, onSelect: () => setDialogOpen(true) });
  }

  const loading = list === undefined && error === undefined;
  const triggerText = loading ? 'Loading workspaces…' : error !== undefined ? 'Workspaces unavailable' : current;

  return (
    <div className="nav-workspace">
      <Menu
        label="Switch workspace"
        items={items}
        disabled={loading || error !== undefined}
        disabledReason={loading ? 'Loading workspaces' : error}
        trigger={
          collapsed
            ? {
                icon: FolderOpen,
                variant: 'ghost',
                size: 'sm',
                ariaLabel: `Switch workspace: ${triggerText}`,
                title: triggerText,
              }
            : { text: triggerText, icon: FolderOpen, variant: 'ghost', size: 'sm', caret: true }
        }
      />
      <AddWorkspaceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onAdded={(item) => void onAdded(item)} />
    </div>
  );
}
