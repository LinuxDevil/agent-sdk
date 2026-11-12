import { useCallback, useState } from 'react';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useToast } from '../../ui/Toast';
import type { VersionListItem } from '../../../shared/wireTypes';

/** What {@link useVersionActions} needs from the tab: ids, refetches and the editor reload. */
export interface VersionActionsDeps {
  agentId: string;
  /** Re-fetches the version timeline (`useVersions().refresh`). */
  refreshVersions(): Promise<void>;
  /** Re-fetches the agent record (the detail context's `refresh`). */
  refreshRecord(): void;
  /** The open editor's `reload` - a restore drops local edits (`discardLocal`). */
  reload(options?: { discardLocal?: boolean }): Promise<boolean>;
  /** The version the restore dialog is confirming (for the toast's `from`). */
  restoreFor: number | null;
}

/**
 * The Versions tab's three mutations (L01 save, L03 restore, L14b
 * publish-this): each toasts its outcome, then refetches what it moved -
 * the timeline always, the record when the publish pointer or working
 * copy changed, the editor's document on a restore. Kept out of
 * `VersionsTab` so the component stays a layout shell.
 */
export function useVersionActions({
  agentId,
  refreshVersions,
  refreshRecord,
  reload,
  restoreFor,
}: VersionActionsDeps): {
  saving: boolean;
  saveVersion(): Promise<void>;
  restored(item: VersionListItem): void;
  published(version: number): void;
} {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const saveVersion = useCallback(async () => {
    setSaving(true);
    try {
      const { item, created } = await runtimeClient.saveVersion(agentId);
      toast.show({
        message: created ? `Saved v${item.version}` : `Nothing changed since v${item.version}`,
        tone: created ? 'success' : 'info',
      });
      await refreshVersions();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setSaving(false);
    }
  }, [agentId, refreshVersions, toast]);

  // L03: the restore wrote a new version server-side; the open editor
  // drops its local edits for the restored spec (`discardLocal`), the
  // record and the timeline refetch, and the dialog closes.
  const restored = useCallback(
    (item: VersionListItem) => {
      const from = item.restoredFromVersion ?? restoreFor;
      toast.show({ message: `Restored v${from} as v${item.version}`, tone: 'success' });
      void reload({ discardLocal: true });
      refreshRecord();
      void refreshVersions();
    },
    [refreshRecord, refreshVersions, reload, restoreFor, toast],
  );

  // L14b: the publish wrote `meta.publishedVersion`; the record refetch
  // moves the Published badge (and the header's pill) and the timeline
  // re-reads for the pointer's new state.
  const published = useCallback(
    (version: number) => {
      toast.show({ message: `Published v${version}`, tone: 'success' });
      refreshRecord();
      void refreshVersions();
    },
    [refreshRecord, refreshVersions, toast],
  );

  return { saving, saveVersion, restored, published };
}
