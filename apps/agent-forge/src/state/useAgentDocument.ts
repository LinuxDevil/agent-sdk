import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [agents, setAgents] = useState<AgentStoreEntry[]>([]);
  const lastValidSpec = useRef<AgentSpec>(DEFAULT_SPEC);

  const spec = useMemo(() => {
    const derived = deriveSpec(graph, lastValidSpec.current);
    lastValidSpec.current = derived;
    return derived;
  }, [graph]);

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
    void (async () => {
      let list: AgentStoreEntry[] = [];
      try {
        list = await store.list();
      } catch {
        return; // Server unreachable: stay on the unsaved default agent.
      }
      if (cancelled) return;
      setAgents(list);
      const id = list.some((entry) => entry.id === agentId) ? agentId : list[0]?.id;
      if (!id) return;
      const loaded = await store.load(id).catch(() => undefined);
      if (cancelled || !loaded) return;
      const loadedGraph = specToGraph(loaded);
      setAgentId(id);
      setGraphState(loadedGraph);
      lastValidSpec.current = loaded;
      setSelectedNodeId(firstLlmNodeId(loadedGraph));
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only - `switchAgent` handles later
    // agent changes explicitly rather than re-running this on agentId writes.
  }, []);

  const save = useCallback(async () => {
    await store.save(agentId, spec);
    setDirty(false);
    await refreshAgents();
  }, [store, agentId, spec, refreshAgents]);

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

  useAutosave({ store, agentId, spec, dirty, setDirty, refreshAgents });

  const switchAgent = useCallback(
    async (id: string) => {
      const loaded = await store.load(id);
      const nextGraph = specToGraph(loaded ?? DEFAULT_SPEC);
      setAgentId(id);
      setGraphState(nextGraph);
      lastValidSpec.current = loaded ?? DEFAULT_SPEC;
      setSelectedNodeId(firstLlmNodeId(nextGraph));
      setDirty(false);
    },
    [store]
  );

  const createAgent = useCallback(
    async (id: string, template: TemplateId) => {
      // Eve DUI-F3: never persist an id the server would reject.
      const problem = agentIdProblem(id);
      if (problem) throw new Error(`Invalid agent name '${id}': ${problem}`);
      const nextGraph = graphFromTemplate(template);
      const nextSpec = graphToSpec(nextGraph);
      await store.save(id, nextSpec);
      setAgentId(id);
      setGraphState(nextGraph);
      lastValidSpec.current = nextSpec;
      setSelectedNodeId(firstLlmNodeId(nextGraph));
      setDirty(false);
      await refreshAgents();
    },
    [store, refreshAgents]
  );

  return {
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
