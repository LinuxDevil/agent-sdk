/**
 * The app's workspace context (W04a): loads `GET /workspaces` once,
 * records the launch id for `activeWorkspace()`, and re-renders
 * `activeId` on every `hashchange` so `#/w/<ws>/…` URLs switch the
 * workspace every `RuntimeClient` request targets.
 *
 * It never blocks rendering - children mount while the list loads, and
 * requests made before it answers omit `x-lousho-workspace` and hit the
 * server's launch default, which is the same workspace anyway.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceListItem } from '../../shared/wireTypes';
import { runtimeClient, RuntimeApiError } from '../runtime/runtimeClient';
import { activeWorkspace, setLaunchWorkspace } from './activeWorkspace';

export interface WorkspacesState {
  /** Every registered workspace; `undefined` while the first load is in flight. */
  list: WorkspaceListItem[] | undefined;
  /** `GET /workspaces`' `defaultId` - the launch workspace; `undefined` while loading. */
  launchId: string | undefined;
  /** `activeWorkspace()`, re-rendered on `hashchange`. */
  activeId: string | undefined;
  /** The load's error message, when the last `GET /workspaces` failed. */
  error: string | undefined;
  /** Reloads the list (e.g. after adding/removing a workspace). */
  refresh(): Promise<void>;
}

const WorkspacesContext = createContext<WorkspacesState | undefined>(undefined);

export function WorkspacesProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<WorkspaceListItem[] | undefined>(undefined);
  const [launchId, setLaunchId] = useState<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(() => activeWorkspace());
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const result = await runtimeClient.listWorkspaces();
      setLaunchWorkspace(result.defaultId);
      setList(result.workspaces);
      setLaunchId(result.defaultId);
      setActiveId(activeWorkspace());
      setError(undefined);
    } catch (e) {
      setError(e instanceof RuntimeApiError ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onHashChange = () => setActiveId(activeWorkspace());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  return (
    <WorkspacesContext.Provider value={{ list, launchId, activeId, error, refresh }}>
      {children}
    </WorkspacesContext.Provider>
  );
}

/** The workspace context; throws when used outside `WorkspacesProvider`. */
export function useWorkspaces(): WorkspacesState {
  const ctx = useContext(WorkspacesContext);
  if (ctx === undefined) throw new Error('useWorkspaces must be used inside <WorkspacesProvider>');
  return ctx;
}
