import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { LocalStorageAgentStore } from '../persistence/LocalStorageAgentStore';
import type { AgentStore } from '../persistence/AgentStore';

const AUTOSAVE_DEBOUNCE_MS = 800;

const DEFAULT_SPEC: AgentSpec = {
  name: 'untitled-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

export type RailTab = 'agents' | 'nodes';
export type DrawerTab = 'chat' | 'logs' | 'trace' | 'output' | 'settings';

interface AppState {
  store: AgentStore;
  agentId: string;
  spec: AgentSpec;
  /** True when `spec` has unsaved changes since the last successful `save()`. */
  dirty: boolean;
  setSpec: (updater: (spec: AgentSpec) => AgentSpec) => void;
  save: () => Promise<void>;
  railTab: RailTab;
  setRailTab: (tab: RailTab) => void;
  drawerTab: DrawerTab;
  setDrawerTab: (tab: DrawerTab) => void;
}

const AppStateContext = createContext<AppState | undefined>(undefined);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new LocalStorageAgentStore(), []);
  const [agentId] = useState('untitled-agent');
  const [spec, setSpecState] = useState<AgentSpec>(DEFAULT_SPEC);
  const [dirty, setDirty] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>('agents');
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('chat');
  const autosaveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Load any previously-saved spec for this agent on mount.
  useEffect(() => {
    let cancelled = false;
    store.load(agentId).then((loaded) => {
      if (!cancelled && loaded) setSpecState(loaded);
    });
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only, for this fixed agentId - not
    // re-run on `store` identity changes (it's a stable useMemo instance).
  }, []);

  const save = useCallback(async () => {
    await store.save(agentId, spec);
    setDirty(false);
  }, [store, agentId, spec]);

  const setSpec = useCallback((updater: (spec: AgentSpec) => AgentSpec) => {
    setSpecState((prev) => updater(prev));
    setDirty(true);
  }, []);

  // Autosave: debounce writes so we're not hitting localStorage on every
  // keystroke, but still persist without an explicit Save click.
  useEffect(() => {
    if (!dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      store.save(agentId, spec).then(() => setDirty(false));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [spec, dirty, store, agentId]);

  const value: AppState = {
    store,
    agentId,
    spec,
    dirty,
    setSpec,
    save,
    railTab,
    setRailTab,
    drawerTab,
    setDrawerTab,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
