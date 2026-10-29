import { useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import { filterLogs } from '../../state/logReducer';
import type { LogEntry, LogLevel, LogPhase } from '../../../shared/wireTypes';
import type { StatusTone } from '../../ui/StatusPill';
import { TonePill } from './TonePill';
import type { AgentGraphSpec } from '../../graph/types';
import { VirtualList } from './VirtualList';
import { findLlmNodeId, findToolNodeId } from './nodeLookup';
import { formatTime } from '../formatTime';

const LEVELS: LogLevel[] = ['info', 'warn', 'error', 'tool'];
const PHASES: LogPhase[] = ['trigger', 'llm', 'tool', 'sandbox', 'checkpoint', 'approval', 'debug'];
const ROW_HEIGHT = 28;

/** Each level's status-pill tone: info blue, warn amber, error red, tool violet. */
const LEVEL_TONES: Record<LogLevel, StatusTone> = { info: 'running', warn: 'warning', error: 'error', tool: 'violet' };

function nodeIdForLog(graph: AgentGraphSpec, entry: LogEntry): string | undefined {
  if (entry.phase === 'llm') return findLlmNodeId(graph);
  if (entry.phase === 'tool') return findToolNodeId(graph, entry.toolName);
  return undefined;
}

function toggledCopy<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function useLogFilters() {
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set());
  const [phases, setPhases] = useState<Set<LogPhase>>(new Set());
  const [search, setSearch] = useState('');
  return {
    levels,
    phases,
    search,
    setSearch,
    toggleLevel: (level: LogLevel) => setLevels((s) => toggledCopy(s, level)),
    togglePhase: (phase: LogPhase) => setPhases((s) => toggledCopy(s, phase)),
  };
}

type LogFilters = ReturnType<typeof useLogFilters>;

function FilterToggles<T extends string>({
  options,
  active,
  onToggle,
  titlePrefix,
}: {
  options: T[];
  active: Set<T>;
  onToggle: (option: T) => void;
  titlePrefix: string;
}) {
  return (
    <>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`logs-filter-toggle${active.has(option) ? ' on' : ''}`}
          onClick={() => onToggle(option)}
          title={`${titlePrefix}: ${option}`}
        >
          {option}
        </button>
      ))}
    </>
  );
}

function LogFilterBar({ filters }: { filters: LogFilters }) {
  return (
    <div className="logs-filter-bar">
      {/* Two labelled groups, so the level "tool" and the phase "tool" are told apart. */}
      <div className="logs-filter-group" role="group" aria-label="Level">
        <span className="overline" aria-hidden="true">
          Level
        </span>
        <FilterToggles options={LEVELS} active={filters.levels} onToggle={filters.toggleLevel} titlePrefix="Filter by level" />
      </div>
      <div className="logs-filter-group" role="group" aria-label="Phase">
        <span className="overline" aria-hidden="true">
          Phase
        </span>
        <FilterToggles
          options={PHASES}
          active={filters.phases}
          onToggle={filters.togglePhase}
          titlePrefix="Filter by phase/node"
        />
      </div>
      <input
        type="search"
        className="input logs-search"
        aria-label="Search logs"
        placeholder="Search logs..."
        value={filters.search}
        onChange={(e) => filters.setSearch(e.target.value)}
      />
    </div>
  );
}

/** `[phase] message`, then the entry's detail as JSON when it has one. */
export function logTitle(entry: LogEntry): string {
  const line = `[${entry.phase}] ${entry.message}`;
  return entry.detail === undefined ? line : `${line}\n${JSON.stringify(entry.detail)}`;
}

function LogRow({ entry, highlighted, onSelect }: { entry: LogEntry; highlighted: boolean; onSelect: () => void }) {
  return (
    <div
      className={`log-line${highlighted ? ' highlighted' : ''}`}
      style={{ height: ROW_HEIGHT }}
      onClick={onSelect}
      // The message truncates in its row: the tooltip carries it in full, plus any detail.
      title={logTitle(entry)}
    >
      <span className="log-time">{formatTime(entry.timestamp)}</span>
      <span className={`log-level lvl-${entry.level}`}>
        <TonePill tone={LEVEL_TONES[entry.level]} label={entry.level} />
      </span>
      <span className="log-msg">
        <b>[{entry.phase}]</b> {entry.message}
      </span>
    </div>
  );
}

/**
 * Live log feed. Reads `AppState.logs` (a capped ring buffer fed by
 * `{type:'log'}` WS messages - see state/AppState.tsx and
 * server/runRegistry.ts's `toLogEntries()`), rendered through `VirtualList`
 * so a long run's log volume doesn't bloat the DOM.
 */
export function LogsPanel() {
  const { logs, highlightedNodeId, setHighlightedNodeId, graph } = useAppState();
  const filters = useLogFilters();
  const { levels, phases, search } = filters;

  const filtered = useMemo(() => filterLogs(logs, { levels, phases, search }), [logs, levels, phases, search]);

  const emptyMessage =
    logs.length === 0
      ? 'No log lines yet - run the agent to see live execution logs here.'
      : 'No log lines match the current filter.';

  return (
    <div className="logs-panel">
      <LogFilterBar filters={filters} />
      {filtered.length > 0 && (
        <div className="log-line log-head" aria-hidden="true">
          <span>Time</span>
          <span>Level</span>
          <span>Message</span>
        </div>
      )}
      <VirtualList
        items={filtered}
        rowHeight={ROW_HEIGHT}
        emptyMessage={emptyMessage}
        label="Log lines"
        renderRow={(entry: LogEntry) => {
          const nodeId = nodeIdForLog(graph, entry);
          return (
            <LogRow
              key={entry.id}
              entry={entry}
              highlighted={!!nodeId && nodeId === highlightedNodeId}
              onSelect={() => setHighlightedNodeId(nodeId)}
            />
          );
        }}
      />
    </div>
  );
}
