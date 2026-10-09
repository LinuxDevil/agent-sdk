import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AgentSpec } from '@lousho/build-ai-agent';
import type { AgentStore, AgentStoreEntry } from '../persistence/AgentStore';
import { graphToSpec } from '../graph/graphToSpec';
import { specToGraph } from '../graph/specToGraph';
import type { AgentGraphSpec } from '../graph/types';
import { graphFromTemplate, type TemplateId } from '../canvas/templates';
import { agentIdProblem } from '../../shared/agentId';

const AUTOSAVE_DEBOUNCE_MS = 800;

const DEFAULT_SPEC: AgentSpec = {
  name: 'untitled-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

function deriveSpec(graph: AgentGraphSpec, fallback: AgentSpec): AgentSpec {
  try {
    return graphToSpec(graph);
  } catch {
    // No llm node yet (e.g. mid-edit after deleting it) - keep the last
    // spec that successfully derived rather than crashing the UI.
    return fallback;
  }
}

function firstLlmNodeId(graph: AgentGraphSpec): string | undefined {
  return graph.nodes.find((n) => n.type === 'llm')?.id;
}

interface AutosaveDeps {
  store: AgentStore;
  agentId: string;
  spec: AgentSpec;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  refreshAgents: () => Promise<void>;
}

/**
 * Autosave: debounce writes so we're not hitting the server on every
 * node drag frame, but still persist without an explicit Save click. A
 * failed save leaves the document dirty (HttpAgentStore keeps a draft).
 */
function useAutosave({ store, agentId, spec, dirty, setDirty, refreshAgents }: AutosaveDeps): void {
  const autosaveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      store.save(agentId, spec).then(
        () => {
          setDirty(false);
          void refreshAgents();
        },
        () => {
          // Stays dirty: the UNSAVED badge keeps showing, and the next edit or Save retries.
        }
      );
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [spec, dirty, store, agentId, refreshAgents]);
}

/** The setters of the open document that loading, switching, renaming and deleting agents write. */
interface DocumentSetters {
  setAgentId: (id: string) => void;
  setGraphState: Dispatch<SetStateAction<AgentGraphSpec>>;
  lastValidSpec: MutableRefObject<AgentSpec>;
  setSelectedNodeId: (id: string | undefined) => void;
  setDirty: (dirty: boolean) => void;
}

/** Opens `nextSpec` / `nextGraph` as agent `id`; `select` selects its llm node, `clean` clears the dirty flag. */
function showAgent(
  doc: DocumentSetters,
  id: string,
  nextSpec: AgentSpec,
  nextGraph: AgentGraphSpec,
  { select = true, clean = true }: { select?: boolean; clean?: boolean } = {}
): void {
  doc.setAgentId(id);
  doc.setGraphState(nextGraph);
  doc.lastValidSpec.current = nextSpec;
  if (select) doc.setSelectedNodeId(firstLlmNodeId(nextGraph));
  if (clean) doc.setDirty(false);
}

/**
 * On mount: the agent list from the server (`.lousho/agents/`), and the
 * first saved agent (`preferredId` when it is saved) - or, when there is
 * none, the unsaved default stays open.
 */
async function loadInitialAgent(
  store: AgentStore,
  preferredId: string,
  isCancelled: () => boolean,
  setAgents: (agents: AgentStoreEntry[]) => void,
  doc: DocumentSetters
): Promise<void> {
  let list: AgentStoreEntry[] = [];
  try {
    list = await store.list();
  } catch {
    return; // Server unreachable: stay on the unsaved default agent.
  }
  if (isCancelled()) return;
  setAgents(list);
  const id = list.some((entry) => entry.id === preferredId) ? preferredId : list[0]?.id;
  if (!id) return;
  const loaded = await store.load(id).catch(() => undefined);
  if (isCancelled() || !loaded) return;
  showAgent(doc, id, loaded, specToGraph(loaded), { clean: false });
}

/** What renaming or deleting a saved agent needs of the document. */
interface AgentListContext {
  store: AgentStore;
  agents: AgentStoreEntry[];
  agentId: string;
  refreshAgents: () => Promise<void>;
  doc: DocumentSetters;
}

/** Eve DUI-F21: saves agent `fromId` (renamed) as `toId`, deletes the old file, and follows the rename when it is open. */
async function renameSavedAgent({ store, agents, agentId, refreshAgents, doc }: AgentListContext, spec: AgentSpec, fromId: string, toId: string): Promise<void> {
  const problem = agentIdProblem(toId);
  if (problem) throw new Error(`Invalid agent name '${toId}': ${problem}`);
  if (toId === fromId) return;
  if (agents.some((entry) => entry.id === toId)) throw new Error(`An agent named '${toId}' already exists`);
  const current = fromId === agentId ? spec : await store.load(fromId);
  if (!current) throw new Error(`Agent '${fromId}' not found`);
  const renamed: AgentSpec = { ...current, name: toId };
  await store.save(toId, renamed);
  await store.remove(fromId);
  if (fromId === agentId) showAgent(doc, toId, renamed, specToGraph(renamed), { select: false });
  await refreshAgents();
}

/** Eve DUI-F21: deletes saved agent `id`; deleting the open one opens the next, or a fresh default. */
async function deleteSavedAgent(
  { store, agents, agentId, refreshAgents, doc }: AgentListContext,
  setAgents: (agents: AgentStoreEntry[]) => void,
  id: string
): Promise<void> {
  await store.remove(id);
  const remaining = agents.filter((entry) => entry.id !== id);
  setAgents(remaining);
  if (id === agentId) {
    const nextId = remaining[0]?.id;
    const loaded = nextId ? await store.load(nextId).catch(() => undefined) : undefined;
    const nextSpec = loaded ?? DEFAULT_SPEC;
    showAgent(doc, loaded && nextId ? nextId : DEFAULT_SPEC.name, nextSpec, specToGraph(nextSpec));
  }
  await refreshAgents();
}

/**
 * The saved-agent list and its refresh; on mount it loads the list and opens
 * the first saved agent (`initialId` when it is saved).
 */
function useAgentList(store: AgentStore, initialId: string, doc: DocumentSetters) {
  const [agents, setAgents] = useState<AgentStoreEntry[]>([]);

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await store.list());
    } catch {
      // Server unreachable: keep the last list rather than failing the caller.
    }
  }, [store]);

  // On mount: the agent list from the server (`.lousho/agents/`), and the
  // first saved agent - or, when there is none, an unsaved 'untitled-agent'.
  useEffect(() => {
    let cancelled = false;
    void loadInitialAgent(store, initialId, () => cancelled, setAgents, doc);
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only - `switchAgent` handles later
    // agent changes explicitly rather than re-running this on agentId writes.
  }, []);

  return { agents, setAgents, refreshAgents };
}

/** `setGraph` / `setSpec`: edit the document's graph directly or through its derived spec, marking it dirty. */
function useGraphEditors(doc: DocumentSetters) {
  const { setGraphState, setDirty, setSelectedNodeId, lastValidSpec } = doc;
  const setGraph = useCallback((updater: (graph: AgentGraphSpec) => AgentGraphSpec) => {
    setGraphState((prev) => updater(prev));
    setDirty(true);
  }, []);

  const setSpec = useCallback(
    (updater: (spec: AgentSpec) => AgentSpec) => {
      setGraphState((prev) => specToGraph(updater(deriveSpec(prev, lastValidSpec.current))));
      setSelectedNodeId(undefined);
      setDirty(true);
    },
    []
  );

  return { setGraph, setSpec };
}

/** Switching to, creating, renaming and deleting saved agents. */
function useAgentActions(context: AgentListContext, spec: AgentSpec, setAgents: (agents: AgentStoreEntry[]) => void) {
  const { store, agents, agentId, refreshAgents, doc } = context;

  const switchAgent = useCallback(
    async (id: string) => {
      const loaded = await store.load(id);
      const nextSpec = loaded ?? DEFAULT_SPEC;
      showAgent(doc, id, nextSpec, specToGraph(nextSpec));
    },
    [store]
  );

  const createAgent = useCallback(
    async (id: string, template: TemplateId) => {
      // Eve DUI-F3: never persist an id the server would reject.
      const problem = agentIdProblem(id);
      if (problem) throw new Error(`Invalid agent name '${id}': ${problem}`);
      // Eve DUI-F21: the agent is named what the user typed, not the template's name.
      const nextGraph = graphFromTemplate(template, id);
      const nextSpec = graphToSpec(nextGraph);
      await store.save(id, nextSpec);
      showAgent(doc, id, nextSpec, nextGraph);
      await refreshAgents();
    },
    [store, refreshAgents]
  );

  /**
   * Eve DUI-F21: renames a saved agent - saves its spec (renamed) under the
   * new id, then deletes the old file. Chats, traces and checkpoints stay
   * under the old id in `.lousho/agents/`.
   */
  const renameAgent = useCallback(
    (fromId: string, toId: string) => renameSavedAgent({ store, agents, agentId, refreshAgents, doc }, spec, fromId, toId),
    [store, agents, agentId, spec, refreshAgents]
  );

  /** Eve DUI-F21: deletes a saved agent (`DELETE /agents/:id`); deleting the open one opens the next, or a fresh default. */
  const deleteAgent = useCallback(
    (id: string) => deleteSavedAgent({ store, agents, agentId, refreshAgents, doc }, setAgents, id),
    [store, agents, agentId, refreshAgents]
  );

  return { switchAgent, createAgent, renameAgent, deleteAgent };
}

/**
 * The editable document for the currently-loaded agent: its id, canonical
 * graph, derived spec, dirty flag, selection, and the saved-agent list -
 * plus load/save/autosave and switching/creating agents.
 */
export function useAgentDocument(store: AgentStore) {
  const [agentId, setAgentId] = useState('untitled-agent');
  const [graph, setGraphState] = useState<AgentGraphSpec>(() => specToGraph(DEFAULT_SPEC));
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const lastValidSpec = useRef<AgentSpec>(DEFAULT_SPEC);
  const doc: DocumentSetters = { setAgentId, setGraphState, lastValidSpec, setSelectedNodeId, setDirty };
  const { agents, setAgents, refreshAgents } = useAgentList(store, agentId, doc);

  const spec = useMemo(() => {
    const derived = deriveSpec(graph, lastValidSpec.current);
    lastValidSpec.current = derived;
    return derived;
  }, [graph]);

  const save = useCallback(async () => {
    await store.save(agentId, spec);
    setDirty(false);
    await refreshAgents();
  }, [store, agentId, spec, refreshAgents]);

  const { setGraph, setSpec } = useGraphEditors(doc);

  useAutosave({ store, agentId, spec, dirty, setDirty, refreshAgents });

  const { switchAgent, createAgent, renameAgent, deleteAgent } = useAgentActions({ store, agents, agentId, refreshAgents, doc }, spec, setAgents);

  return {
    renameAgent,
    deleteAgent,
    agentId,
    graph,
    setGraph,
    spec,
    setSpec,
    dirty,
    save,
    selectedNodeId,
    setSelectedNodeId,
    agents,
    switchAgent,
    createAgent,
  };
}
