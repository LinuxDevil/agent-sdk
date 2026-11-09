import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AgentSpecV2 } from 'lousho';
import type { AgentStore } from '../persistence/AgentStore';
import { graphToSpec, type GraphToSpecResult } from '../graph/v2/graphToSpec';
import { specToGraph } from '../graph/v2/specToGraph';
import { deriveEdges } from '../graph/v2/edges';
import { validateGraph } from '../graph/v2/validateGraph';
import type { Graph, GraphEdge, Problem } from '../graph/v2/types';
import { graphFromTemplate, type TemplateId } from '../canvas/templates';
import { agentIdProblem } from '../../shared/agentId';
import type { CanvasLayout, StudioEvent } from '../../shared/wireTypes';
import { useStudioEvents } from './useStudioEvents';

const AUTOSAVE_DEBOUNCE_MS = 800;
/** How long `agent.changed` events collect before the agents list re-fetches - a burst (rename = save+delete) is one refresh. */
const AGENTS_REFRESH_DEBOUNCE_MS = 300;
/** Validation (`validateGraph`: `graphToSpec` + zod) trails edits by this long so typing never blocks on it. */
const PROBLEMS_DEBOUNCE_MS = 300;

const DEFAULT_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'untitled-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};

function deriveSpec(graph: Graph, fallback: GraphToSpecResult): GraphToSpecResult {
  try {
    return graphToSpec(graph, fallback.spec);
  } catch {
    // graphToSpec throws only when the root agent is missing, which
    // removeNode prevents - keep the last successful derive anyway rather
    // than crashing the UI on a transient mid-edit graph.
    return fallback;
  }
}

type DocumentJson = { spec: string; layout: string };

function jsonOf(derived: GraphToSpecResult): DocumentJson {
  return { spec: JSON.stringify(derived.spec), layout: JSON.stringify(derived.layout) };
}

function sameJson(a: DocumentJson, b: DocumentJson): boolean {
  return a.spec === b.spec && a.layout === b.layout;
}

interface AutosaveDeps extends SaveDeps {
  dirty: boolean;
}

interface SaveDeps {
  store: AgentStore;
  agentId: string;
  derived: GraphToSpecResult;
  setDirty: (dirty: boolean) => void;
  refreshAgents: () => Promise<void>;
  /** Canonical JSON of the spec and layout last confirmed written (shared with the explicit `save()`). */
  lastSavedJson: MutableRefObject<{ spec: string; layout: string }>;
  /** Canonical JSON of the LATEST derived document, refreshed on every render - a newer edit's JSON. */
  latestJson: MutableRefObject<{ spec: string; layout: string }>;
}

/** The spec and layout writes a document needs to catch up, in canonical-JSON order (spec first). */
function pendingSaves(store: AgentStore, agentId: string, derived: GraphToSpecResult, lastSaved: { spec: string; layout: string }): {
  json: { spec: string; layout: string };
  writes: Promise<void>[];
} {
  const json = jsonOf(derived);
  const writes: Promise<void>[] = [];
  if (json.spec !== lastSaved.spec) writes.push(store.save(agentId, derived.spec));
  if (json.layout !== lastSaved.layout) writes.push(store.saveLayout(agentId, derived.layout));
  return { json, writes };
}

/**
 * Autosave: debounce writes so we're not hitting the server on every
 * node drag frame, but still persist without an explicit Save click. The
 * spec and the layout are saved independently - a pure move changes only
 * the layout's JSON, so `PUT /agents/:id/layout` fires without rewriting
 * `<id>.yaml`. A failed save leaves the document dirty (HttpAgentStore
 * keeps a draft).
 */
function useAutosave({ store, agentId, derived, dirty, setDirty, refreshAgents, lastSavedJson, latestJson }: AutosaveDeps): void {
  const autosaveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      const { json, writes } = pendingSaves(store, agentId, derived, lastSavedJson.current);
      if (writes.length === 0) {
        setDirty(false);
        return;
      }
      Promise.all(writes).then(
        () => {
          lastSavedJson.current = json;
          // Clear dirty only when no newer edit landed while the write was
          // in flight: a stale write clearing dirty would cancel the newer
          // edit's pending autosave (this effect re-runs on `dirty`) and
          // silently lose it.
          if (sameJson(latestJson.current, json)) {
            setDirty(false);
          }
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
  }, [derived, dirty, store, agentId, refreshAgents, lastSavedJson, latestJson]);
}

function useExplicitSave({ store, agentId, derived, setDirty, refreshAgents, lastSavedJson, latestJson }: SaveDeps) {
  return useCallback(async () => {
    const json = jsonOf(derived);
    await store.save(agentId, derived.spec);
    await store.saveLayout(agentId, derived.layout);
    lastSavedJson.current = json;
    if (sameJson(latestJson.current, json)) {
      setDirty(false);
    }
    await refreshAgents();
  }, [store, agentId, derived, setDirty, refreshAgents, lastSavedJson, latestJson]);
}

/** The setters of the open document that loading, switching, renaming and deleting agents write. */
interface DocumentSetters {
  setAgentId: (id: string) => void;
  setGraphState: Dispatch<SetStateAction<Graph>>;
  lastDerived: MutableRefObject<GraphToSpecResult>;
  lastSavedJson: MutableRefObject<{ spec: string; layout: string }>;
  setSelectedNodeId: (id: string | undefined) => void;
  setDirty: (dirty: boolean) => void;
}

/**
 * Opens `nextSpec` / `nextGraph` as agent `id` with nothing selected - so the
 * Inspector stays collapsed and the canvas gets the width to show the whole
 * graph legibly (AgentsScreen.tsx); `keepSelection` leaves the selection as
 * it is (a rename), `clean` clears the dirty flag. Resets the derived-spec
 * and last-saved-JSON refs so the freshly opened document never autosaves
 * what it just read.
 */
function showAgent(
  doc: DocumentSetters,
  id: string,
  nextSpec: AgentSpecV2,
  nextGraph: Graph,
  { keepSelection = false, clean = true }: { keepSelection?: boolean; clean?: boolean } = {}
): void {
  const derived = graphToSpec(nextGraph, nextSpec);
  doc.setAgentId(id);
  doc.setGraphState(nextGraph);
  doc.lastDerived.current = derived;
  doc.lastSavedJson.current = jsonOf(derived);
  if (!keepSelection) doc.setSelectedNodeId(undefined);
  if (clean) doc.setDirty(false);
}

/** `specToGraph` of a loaded record: positions come from its `layout.json`. */
function graphOfRecord(record: { spec: AgentSpecV2; layout: CanvasLayout }): Graph {
  return specToGraph(record.spec, record.layout);
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
  setAgents: (agents: Awaited<ReturnType<AgentStore['list']>>) => void,
  doc: DocumentSetters
): Promise<void> {
  let list: Awaited<ReturnType<AgentStore['list']>> = [];
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
  showAgent(doc, id, loaded.spec, graphOfRecord(loaded), { clean: false });
}

/** What renaming or deleting a saved agent needs of the document. */
interface AgentListContext {
  store: AgentStore;
  agents: Awaited<ReturnType<AgentStore['list']>>;
  agentId: string;
  refreshAgents: () => Promise<void>;
  doc: DocumentSetters;
}

/** Saves agent `fromId` (renamed) as `toId`, deletes the old file, and follows the rename when it is open. */
async function renameSavedAgent(
  { store, agents, agentId, refreshAgents, doc }: AgentListContext,
  derived: GraphToSpecResult,
  fromId: string,
  toId: string
): Promise<void> {
  const problem = agentIdProblem(toId);
  if (problem) throw new Error(`Invalid agent name '${toId}': ${problem}`);
  if (toId === fromId) return;
  if (agents.some((entry) => entry.id === toId)) throw new Error(`An agent named '${toId}' already exists`);
  const current = fromId === agentId ? derived : await store.load(fromId);
  if (!current) throw new Error(`Agent '${fromId}' not found`);
  const renamed: AgentSpecV2 = { ...current.spec, name: toId };
  await store.save(toId, renamed);
  // The rename keeps the layout: the new id inherits the old one's positions.
  await store.saveLayout(toId, current.layout);
  await store.remove(fromId);
  if (fromId === agentId) {
    const graph = specToGraph(renamed, current.layout);
    showAgent(doc, toId, renamed, graph, { keepSelection: true });
  }
  await refreshAgents();
}

/** Deletes saved agent `id`; deleting the open one opens the next, or a fresh default. */
async function deleteSavedAgent(
  { store, agents, agentId, refreshAgents, doc }: AgentListContext,
  setAgents: (agents: Awaited<ReturnType<AgentStore['list']>>) => void,
  id: string
): Promise<void> {
  await store.remove(id);
  const remaining = agents.filter((entry) => entry.id !== id);
  setAgents(remaining);
  if (id === agentId) {
    const nextId = remaining[0]?.id;
    const loaded = nextId ? await store.load(nextId).catch(() => undefined) : undefined;
    const nextSpec = loaded?.spec ?? DEFAULT_SPEC;
    const nextGraph = loaded ? graphOfRecord(loaded) : specToGraph(DEFAULT_SPEC);
    showAgent(doc, loaded && nextId ? nextId : DEFAULT_SPEC.name, nextSpec, nextGraph);
  }
  await refreshAgents();
}

/**
 * The `WS /events` handler `useAgentDocument` subscribes: an `agent.changed`
 * (any workspace write - another tab's save, a version capture, a draft
 * approval) re-fetches the agents list, debounced so a burst of writes is
 * one `refreshAgents()`. Other event types are for the later summary,
 * draft, suggestion and inbox consumers.
 */
function useAgentChangedRefresh(refreshAgents: () => Promise<void>): (event: StudioEvent) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    []
  );
  return useCallback(
    (event: StudioEvent) => {
      if (event.type !== 'agent.changed') return;
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void refreshAgents();
      }, AGENTS_REFRESH_DEBOUNCE_MS);
    },
    [refreshAgents]
  );
}

/**
 * The saved-agent list and its refresh; on mount it loads the list and opens
 * the first saved agent (`initialId` when it is saved).
 */
function useAgentList(store: AgentStore, initialId: string, doc: DocumentSetters) {
  const [agents, setAgents] = useState<Awaited<ReturnType<AgentStore['list']>>>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);

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
    void loadInitialAgent(store, initialId, () => cancelled, setAgents, doc).finally(() => {
      if (!cancelled) setAgentsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only - `switchAgent` handles later
    // agent changes explicitly rather than re-running this on agentId writes.
  }, []);

  return { agents, setAgents, refreshAgents, agentsLoaded };
}

/** `setGraph` / `setSpec`: edit the document's graph directly or through its derived spec, marking it dirty. */
function useGraphEditors(doc: DocumentSetters) {
  const { setGraphState, setDirty, setSelectedNodeId, lastDerived } = doc;
  const setGraph = useCallback((updater: (graph: Graph) => Graph) => {
    setGraphState((prev) => updater(prev));
    setDirty(true);
  }, []);

  const setSpec = useCallback(
    (updater: (spec: AgentSpecV2) => AgentSpecV2) => {
      setGraphState((prev) => {
        const current = deriveSpec(prev, lastDerived.current);
        // A whole-spec write keeps the current layout: positions survive an import.
        return specToGraph(updater(current.spec), current.layout);
      });
      setSelectedNodeId(undefined);
      setDirty(true);
    },
    []
  );

  return { setGraph, setSpec };
}

/** Switching to, creating, renaming and deleting saved agents. */
function useAgentActions(
  context: AgentListContext,
  derived: GraphToSpecResult,
  setAgents: (agents: Awaited<ReturnType<AgentStore['list']>>) => void
) {
  const { store, agents, agentId, refreshAgents, doc } = context;

  const switchAgent = useCallback(
    async (id: string) => {
      const loaded = await store.load(id);
      const nextSpec = loaded?.spec ?? DEFAULT_SPEC;
      const nextGraph = loaded ? graphOfRecord(loaded) : specToGraph(DEFAULT_SPEC);
      showAgent(doc, id, nextSpec, nextGraph);
    },
    [store]
  );

  const createAgent = useCallback(
    async (id: string, template: TemplateId) => {
      // Never persist an id the server would reject.
      const problem = agentIdProblem(id);
      if (problem) throw new Error(`Invalid agent name '${id}': ${problem}`);
      // The agent is named what the user typed, not the template's name.
      const nextGraph = graphFromTemplate(template, id);
      const next = graphToSpec(nextGraph);
      await store.save(id, next.spec);
      await store.saveLayout(id, next.layout);
      showAgent(doc, id, next.spec, nextGraph);
      await refreshAgents();
    },
    [store, refreshAgents]
  );

  /**
   * Renames a saved agent - saves its spec and layout under the
   * new id, then deletes the old file. Chats, traces and checkpoints stay
   * under the old id in `.lousho/agents/`.
   */
  const renameAgent = useCallback(
    (fromId: string, toId: string) => renameSavedAgent({ store, agents, agentId, refreshAgents, doc }, derived, fromId, toId),
    [store, agents, agentId, derived, refreshAgents]
  );

  /** Deletes a saved agent (`DELETE /agents/:id`); deleting the open one opens the next, or a fresh default. */
  const deleteAgent = useCallback(
    (id: string) => deleteSavedAgent({ store, agents, agentId, refreshAgents, doc }, setAgents, id),
    [store, agents, agentId, refreshAgents]
  );

  return { switchAgent, createAgent, renameAgent, deleteAgent };
}

function useDocumentState() {
  const [agentId, setAgentId] = useState('untitled-agent');
  const [graph, setGraphState] = useState<Graph>(() => specToGraph(DEFAULT_SPEC));
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const lastDerived = useRef<GraphToSpecResult>(graphToSpec(specToGraph(DEFAULT_SPEC), DEFAULT_SPEC));
  // Canonical JSON of what the server is known to hold: autosave only writes what differs.
  const lastSavedJson = useRef(jsonOf(lastDerived.current));
  // Canonical JSON of the document as currently derived; compared against an
  // in-flight save's JSON so a stale write never clears a newer edit's dirty.
  const latestJson = useRef(lastSavedJson.current);
  const doc: DocumentSetters = { setAgentId, setGraphState, lastDerived, lastSavedJson, setSelectedNodeId, setDirty };
  return { agentId, graph, dirty, selectedNodeId, latestJson, doc };
}

function useDerivedDocument(
  graph: Graph,
  lastDerived: MutableRefObject<GraphToSpecResult>,
  latestJson: MutableRefObject<DocumentJson>
): { derived: GraphToSpecResult; edges: GraphEdge[] } {
  const derived = useMemo(() => {
    const next = deriveSpec(graph, lastDerived.current);
    lastDerived.current = next;
    latestJson.current = jsonOf(next);
    return next;
  }, [graph, lastDerived, latestJson]);
  const edges = useMemo(() => deriveEdges(graph), [graph]);
  return { derived, edges };
}

/**
 * `validateGraph(graph)` debounced by {@link PROBLEMS_DEBOUNCE_MS}: the
 * canvas badges, the Inspector's Problems section and the drawer's
 * Problems tab all read the same list, and validation re-emits the spec
 * and runs zod on every edit, so it must never run per keystroke. The
 * first render validates immediately so a freshly opened agent's
 * problems are there before the first paint settles.
 */
function useProblems(graph: Graph): Problem[] {
  const [problems, setProblems] = useState<Problem[]>(() => validateGraph(graph));
  useEffect(() => {
    const timer = setTimeout(() => setProblems(validateGraph(graph)), PROBLEMS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [graph]);
  return problems;
}

/**
 * The editable document for the currently-loaded agent: its id, canvas
 * `Graph` (graph v2), the spec/layout/nodeIdMap `graphToSpec` derives from
 * it, dirty flag, selection, and the saved-agent list - plus
 * load/save/autosave and switching/creating agents. On mount it opens
 * `initialId` when that agent is saved (the `#/agents/:id` of a reload).
 */
export function useAgentDocument(store: AgentStore, initialId?: string) {
  const { agentId, graph, dirty, selectedNodeId, latestJson, doc } = useDocumentState();
  const { setDirty, lastSavedJson, setSelectedNodeId } = doc;
  const { agents, setAgents, refreshAgents, agentsLoaded } = useAgentList(store, initialId ?? agentId, doc);
  // `WS /events`: another tab's write refreshes this tab's agents list.
  useStudioEvents(useAgentChangedRefresh(refreshAgents));

  const { derived, edges } = useDerivedDocument(graph, doc.lastDerived, latestJson);
  const spec = derived.spec;
  const problems = useProblems(graph);

  const saveDeps: SaveDeps = { store, agentId, derived, setDirty, refreshAgents, lastSavedJson, latestJson };
  const save = useExplicitSave(saveDeps);

  const { setGraph, setSpec } = useGraphEditors(doc);

  useAutosave({ ...saveDeps, dirty });

  const { switchAgent, createAgent, renameAgent, deleteAgent } = useAgentActions(
    { store, agents, agentId, refreshAgents, doc },
    derived,
    setAgents
  );

  return {
    renameAgent,
    deleteAgent,
    agentId,
    graph,
    setGraph,
    spec,
    setSpec,
    edges,
    nodeIdMap: derived.nodeIdMap,
    specPaths: derived.specPaths,
    problems,
    dirty,
    save,
    selectedNodeId,
    setSelectedNodeId,
    agents,
    agentsLoaded,
    switchAgent,
    createAgent,
  };
}
