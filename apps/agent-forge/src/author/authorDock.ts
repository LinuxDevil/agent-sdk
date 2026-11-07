import { useDock, type DockApi } from '../shell/Dock';

/**
 * The Author panel's open state. U03's `DockProvider` owns the one dock
 * column (open persisted as `forge.dock.open`, width as
 * `forge.dock.width`), so this hook is a named view over `useDock()` for
 * Author code: the panel's close control and AA19's `Ctrl+J` toggle read
 * and write the same state the shell's grid reads. A second store would
 * let the panel and the dock column disagree.
 */
export function useAuthorDock(): Pick<DockApi, 'open' | 'setOpen' | 'toggle'> {
  const { open, setOpen, toggle } = useDock();
  return { open, setOpen, toggle };
}
