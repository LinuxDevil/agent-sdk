import { useCallback, useEffect } from 'react';
import { useAppState } from '../../state/AppState';
import { useToast } from '../../ui/Toast';
import { errorMessage } from '../../components/errorMessage';

/**
 * The "Save version" action shared by the Topbar's Save button and the
 * Ctrl/Cmd+S shortcut: `saveVersion()` (`save()` + `POST .../versions`),
 * then a toast naming the outcome - "Saved version v<n>" when a version
 * was written, "No changes since v<n>" when the working copy already
 * matched the latest one. `state.latestVersion` is read after the call,
 * so it is the version this save just reported. Rejects on failure - the
 * caller decides how to surface it.
 */
export function useSaveVersionAction(): () => Promise<void> {
  const state = useAppState();
  const toast = useToast();
  return useCallback(async () => {
    const item = await state.saveVersion();
    toast.show({
      message:
        item !== undefined
          ? `Saved version v${item.version}`
          : `No changes since v${state.latestVersion ?? '?'}`,
      tone: 'success',
    });
  }, [state, toast]);
}

/**
 * The builder screen's Ctrl/Cmd+S binding (`src/shell/shortcuts.ts` lists
 * it on the `?` sheet): `preventDefault()` the browser's own save dialog
 * and run {@link useSaveVersionAction}. It is a save, not text input, so
 * it fires even while typing in inspector fields - which is also why it
 * lives here on the Agents screen rather than in the shell's global
 * `matchShortcut` (palette/help only). A failure lands as an error toast.
 */
export function useSaveVersionShortcut(): void {
  const saveVersionAction = useSaveVersionAction();
  const toast = useToast();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      saveVersionAction().catch((error: unknown) => {
        toast.show({ message: errorMessage(error), tone: 'error' });
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveVersionAction, toast]);
}
