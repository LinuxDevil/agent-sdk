/**
 * The Nodes tab of the left rail (C18): a searchable, grouped palette built
 * from every `PaletteEntry` registered in `KIND_VIEWS`. Groups collapse
 * (persisted in localStorage), `/` focuses the search box, the item list is
 * one roving-tabindex list, and entries drag onto the canvas or add at the
 * viewport centre on click/Enter. An `unavailable` entry renders disabled
 * with its reason as the tooltip and the `role="status"` notice.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAppState } from '../../state/AppState';
import { PALETTE_DRAG_MIME } from '../dnd';
import { isEditableTarget } from '../isEditableTarget';
import { ownerForNewNode } from '../../graph/v2/mutations';
import { ROOT_AGENT_ID } from '../../graph/v2/types';
import { KIND_VIEWS, viewFor, type PaletteEntry, type PaletteGroup } from '../kinds';
import { onRovingKeyDown } from '../../screens/rovingKeys';
import { readStored, writeStored } from '../../components/storedValue';
import { Input } from '../../ui/controls';
import { filterPalette, paletteOwnerTitle, paletteSections, type PaletteSection } from './paletteModel';
import { usePaletteActions } from './usePaletteActions';
import './palette.css';

/** localStorage key for the collapsed group names (JSON array; storage may throw — see storedValue). */
const COLLAPSED_KEY = 'forge.palette.collapsed';

/** The stored collapsed-group set; a missing or corrupt value reads as "nothing collapsed". */
function readCollapsedGroups(): ReadonlySet<string> {
  const raw = readStored(COLLAPSED_KEY);
  if (raw === undefined) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((name): name is string => typeof name === 'string'));
  } catch {
    return new Set();
  }
}

interface PaletteItemProps {
  entry: PaletteEntry;
  /** True for the list's single tab stop; the rest are `-1` until focused. */
  tabbable: boolean;
  onFocusItem: () => void;
  onActivate: () => void;
}

/**
 * A palette entry is a real button - drag it onto the canvas as
 * before, or activate it (click, Enter, Space) to add it without a mouse.
 * A card: the kind's icon tile, its name, and a one-line description.
 * `unavailable` greys it out (`aria-disabled`, not `disabled`, so it stays
 * in the roving list and a click can still announce the reason), makes it
 * undraggable and puts the reason in the tooltip, per the "disabled
 * controls say why" copy rule.
 */
function PaletteItem({ entry, tabbable, onFocusItem, onActivate }: PaletteItemProps) {
  const { graph, selectedNodeId, proposal } = useAppState();
  const view = viewFor(entry.kind);
  // Per-entry overrides let flow steps show their own icon/tone per step type.
  const tone = entry.tone ?? view.tone;
  const Icon = entry.Icon ?? view.Icon;
  // While a proposal overlay is shown the canvas is read-only (C21): every
  // entry is disabled with the reason in its tooltip.
  const reason =
    proposal === undefined
      ? entry.unavailable?.(graph, ownerForNewNode(graph, entry.kind, selectedNodeId))
      : 'Hide the proposal to edit';
  const descriptionId = `palette-${entry.id}-desc`;
  return (
    <button
      type="button"
      className="node-palette-item"
      data-roving
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocusItem}
      draggable={reason === undefined}
      aria-disabled={reason !== undefined ? 'true' : undefined}
      onDragStart={(e: DragEvent<HTMLButtonElement>) => startPaletteDrag(e, entry.id)}
      onClick={onActivate}
      onKeyDown={(e) => {
        // Enter adds explicitly: preventDefault stops the button's native
        // click so the add runs exactly once (Space still clicks natively).
        if (e.key === 'Enter') {
          e.preventDefault();
          onActivate();
        }
      }}
      title={reason ?? 'Drag onto the canvas, or press to add at the centre'}
      // The card's name stays the bare label; the one-line description is its description.
      aria-label={entry.label}
      aria-describedby={descriptionId}
    >
      <span className={`node-kind kind-${tone}`} aria-hidden="true">
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <span className="palette-text">
        <span className="palette-name">{entry.label}</span>
        <span className="palette-desc" id={descriptionId}>
          {entry.description}
        </span>
      </span>
    </button>
  );
}

function startPaletteDrag(e: DragEvent<HTMLButtonElement>, entryId: string) {
  e.dataTransfer.setData(PALETTE_DRAG_MIME, entryId);
  e.dataTransfer.effectAllowed = 'move';
}

interface PaletteGroupSectionProps {
  section: PaletteSection;
  /** Collapsed state is ignored while a search is active (every match shows). */
  expanded: boolean;
  tabbableId: string | undefined;
  onToggle: (group: PaletteGroup) => void;
  onFocusItem: (id: string) => void;
  onActivate: (entry: PaletteEntry) => void;
}

/** One collapsible group: a header button (chevron, name, count) over its items. */
function PaletteGroupSection({
  section,
  expanded,
  tabbableId,
  onToggle,
  onFocusItem,
  onActivate,
}: PaletteGroupSectionProps) {
  const panelId = `palette-group-${section.group}`;
  return (
    <div className="palette-group">
      <button
        type="button"
        className="palette-group-head"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => onToggle(section.group)}
      >
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
        )}
        <span className="palette-group-name overline">{section.group}</span>
        <span className="palette-count tabular-nums">{section.entries.length}</span>
      </button>
      {expanded && (
        <div className="palette-group-items" id={panelId}>
          {section.entries.map((entry) => (
            <PaletteItem
              key={entry.id}
              entry={entry}
              tabbable={entry.id === tabbableId}
              onFocusItem={() => onFocusItem(entry.id)}
              onActivate={() => onActivate(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsedGroups);
  function toggleGroup(group: PaletteGroup) {
    const next = new Set(collapsed);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    writeStored(COLLAPSED_KEY, JSON.stringify([...next]));
    setCollapsed(next);
  }
  return { collapsed, toggleGroup };
}

function useSlashFocus(searchRef: RefObject<HTMLInputElement>) {
  // `/` focuses the search box from anywhere that is not an editable target
  // (inputs, CodeMirror, the Author composer keep their keystrokes).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== '/' || e.defaultPrevented || isEditableTarget(e.target)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchRef]);
}

function usePaletteOwnerTitle(): string | undefined {
  const { graph, selectedNodeId } = useAppState();
  // The hint uses a representative non-note kind: ownerForNewNode only reads
  // the kind for notes and root-only sections, so 'tool' gives the real owner.
  const owner = ownerForNewNode(graph, 'tool', selectedNodeId);
  return owner === ROOT_AGENT_ID ? undefined : paletteOwnerTitle(graph, owner);
}

function focusEdgeItem(list: HTMLElement | null, key: string): HTMLElement | undefined {
  const items = list ? [...list.querySelectorAll<HTMLElement>('[data-roving]')] : [];
  const target = key === 'ArrowDown' ? items[0] : items[items.length - 1];
  target?.focus();
  return target;
}

interface PaletteSearchProps {
  query: string;
  setQuery: (query: string) => void;
  searchRef: RefObject<HTMLInputElement>;
  listRef: RefObject<HTMLDivElement>;
}

function PaletteSearch({ query, setQuery, searchRef, listRef }: PaletteSearchProps) {
  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('');
      return;
    }
    // "/, type, Down, Enter" (the acceptance flow): ArrowDown lands on
    // the first rendered item, ArrowUp on the last.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (focusEdgeItem(listRef.current, e.key) !== undefined) e.preventDefault();
  }
  return (
    <div className="palette-search">
      <Input
        ref={searchRef}
        type="search"
        aria-label="Search nodes"
        placeholder="Search nodes"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

interface PaletteListProps {
  visible: readonly PaletteSection[];
  isExpanded: (section: PaletteSection) => boolean;
  listRef: RefObject<HTMLDivElement>;
  rovingId: string | undefined;
  setRovingId: (id: string) => void;
  onToggle: (group: PaletteGroup) => void;
  onActivate: (entry: PaletteEntry) => void;
}

function PaletteList({ visible, isExpanded, listRef, rovingId, setRovingId, onToggle, onActivate }: PaletteListProps) {
  // Only expanded groups render items (a search expands every match), so the
  // roving list - and its single tab stop - must be computed from these.
  const itemIds = visible
    .filter(isExpanded)
    .flatMap((section) => section.entries.map((entry) => entry.id));
  const tabbableId = rovingId !== undefined && itemIds.includes(rovingId) ? rovingId : itemIds[0];
  return (
    <div className="palette-list" ref={listRef} onKeyDown={onRovingKeyDown}>
      {visible.map((section) => (
        <PaletteGroupSection
          key={section.group}
          section={section}
          expanded={isExpanded(section)}
          tabbableId={tabbableId}
          onToggle={onToggle}
          onFocusItem={setRovingId}
          onActivate={onActivate}
        />
      ))}
    </div>
  );
}

function PaletteEmpty({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="palette-empty">
      <span className="hint">No nodes match '{query.trim()}'.</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
        Clear search
      </button>
    </div>
  );
}

/** The Nodes tab body: search box, owner hint, collapsible groups, add notice. */
export function NodePalette() {
  // KIND_VIEWS is a mutable registry the kind tests extend; sections are
  // recomputed per mount, which is all the palette needs.
  const sections = useMemo(() => paletteSections(KIND_VIEWS), []);
  const { notice, addAtViewportCentre } = usePaletteActions();
  const [query, setQuery] = useState('');
  const { collapsed, toggleGroup } = useCollapsedGroups();
  const [rovingId, setRovingId] = useState<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ownerTitle = usePaletteOwnerTitle();
  useSlashFocus(searchRef);

  const searching = query.trim().length > 0;
  const visible = searching ? filterPalette(sections, query) : sections;
  const isExpanded = (section: PaletteSection) => searching || !collapsed.has(section.group);

  let body;
  if (sections.length === 0) body = <div className="hint">Node types arrive with the next updates.</div>;
  else if (visible.length === 0) body = <PaletteEmpty query={query} onClear={() => setQuery('')} />;
  else
    body = (
      <PaletteList
        visible={visible}
        isExpanded={isExpanded}
        listRef={listRef}
        rovingId={rovingId}
        setRovingId={setRovingId}
        onToggle={toggleGroup}
        onActivate={addAtViewportCentre}
      />
    );

  return (
    <div className="rail-body palette">
      <PaletteSearch query={query} setQuery={setQuery} searchRef={searchRef} listRef={listRef} />
      {ownerTitle !== undefined && <div className="palette-owner">Adding to: {ownerTitle}</div>}
      {body}
      <div className="hint palette-notice" role="status">
        {notice}
      </div>
    </div>
  );
}
