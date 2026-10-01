import { useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import { filterLogs } from '../../state/logReducer';
import type { LogEntry, LogLevel, LogPhase } from '../../../shared/wireTypes';
import type { AgentGraphSpec } from '../../graph/types';
import { VirtualList } from './VirtualList';
import { findLlmNodeId, findToolNodeId } from './nodeLookup';
import { formatTime } from '../formatTime';

const LEVELS: LogLevel[] = ['info', 'warn', 'error', 'tool'];
const PHASES: LogPhase[] = ['trigger', 'llm', 'tool', 'sandbox', 'checkpoint', 'approval', 'debug'];
const ROW_HEIGHT = 22;

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
      <FilterToggles options={LEVELS} active={filters.levels} onToggle={filters.toggleLevel} titlePrefix="Filter by level" />
      <FilterToggles
        options={PHASES}
        active={filters.phases}
        onToggle={filters.togglePhase}
        titlePrefix="Filter by phase/node"
      />
      <input
        type="search"
        placeholder="Search logs..."
        value={filters.search}
        onChange={(e) => filters.setSearch(e.target.value)}
      />
    </div>
  );
}

function LogRow({ entry, highlighted, onSelect }: { entry: LogEntry; highlighted: boolean; onSelect: () => void }) {
  return (
    <div
      className={`log-line${highlighted ? ' highlighted' : ''}`}
      style={{ height: ROW_HEIGHT }}
      onClick={onSelect}
      title={entry.detail ? JSON.stringify(entry.detail) : undefined}
    >
      <span className="log-time">{formatTime(entry.timestamp)}</span>
      <span className={`log-level lvl-${entry.level}`}>{entry.level}</span>
      <span className="log-msg">
        <b>[{entry.phase}]</b> {entry.message}
      </span>
    </div>
  );
}

/**
 * O1: live log feed. Reads `AppState.logs` (a capped ring buffer fed by
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
      <VirtualList
        items={filtered}
        rowHeight={ROW_HEIGHT}
        emptyMessage={emptyMessage}
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
