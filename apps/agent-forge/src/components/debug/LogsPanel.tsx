import { useMemo, useState } from 'react';
import { useAppState } from '../../state/AppState';
import { filterLogs } from '../../state/logReducer';
import type { LogEntry, LogLevel, LogPhase } from '../../runtime/runtimeClient';
import { VirtualList } from './VirtualList';

const LEVELS: LogLevel[] = ['info', 'warn', 'error', 'tool'];
const PHASES: LogPhase[] = ['trigger', 'llm', 'tool', 'sandbox', 'checkpoint', 'approval', 'debug'];
const ROW_HEIGHT = 22;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

/**
 * O1: live log feed. Reads `AppState.logs` (a capped ring buffer fed by
 * `{type:'log'}` WS messages - see state/AppState.tsx and
 * server/runRegistry.ts's `toLogEntries()`), rendered through `VirtualList`
 * so a long run's log volume doesn't bloat the DOM.
 */
export function LogsPanel() {
  const { logs, highlightedNodeId, setHighlightedNodeId, graph } = useAppState();
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set());
  const [phases, setPhases] = useState<Set<LogPhase>>(new Set());
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => filterLogs(logs, { levels, phases, search }), [logs, levels, phases, search]);

  function toggle<T>(set: Set<T>, value: T, setSet: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setSet(next);
  }

  function nodeIdForLog(entry: LogEntry): string | undefined {
    if (entry.phase === 'llm') return graph.nodes.find((n) => n.type === 'llm')?.id;
    if (entry.phase === 'tool' && entry.toolName) {
      return graph.nodes.find((n) => n.type === 'tool' && n.data.toolName === entry.toolName)?.id;
    }
    return undefined;
  }

  return (
    <div className="logs-panel">
      <div className="logs-filter-bar">
        {LEVELS.map((lvl) => (
          <button
            key={lvl}
            type="button"
            className={`logs-filter-toggle${levels.has(lvl) ? ' on' : ''}`}
            onClick={() => toggle(levels, lvl, setLevels)}
            title={`Filter by level: ${lvl}`}
          >
            {lvl}
          </button>
        ))}
        {PHASES.map((phase) => (
          <button
            key={phase}
            type="button"
            className={`logs-filter-toggle${phases.has(phase) ? ' on' : ''}`}
            onClick={() => toggle(phases, phase, setPhases)}
            title={`Filter by phase/node: ${phase}`}
          >
            {phase}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <VirtualList
        items={filtered}
        rowHeight={ROW_HEIGHT}
        emptyMessage={logs.length === 0 ? 'No log lines yet - run the agent to see live execution logs here.' : 'No log lines match the current filter.'}
        renderRow={(entry: LogEntry) => {
          const nodeId = nodeIdForLog(entry);
          return (
            <div
              key={entry.id}
              className={`log-line${nodeId && nodeId === highlightedNodeId ? ' highlighted' : ''}`}
              style={{ height: ROW_HEIGHT }}
              onClick={() => setHighlightedNodeId(nodeId)}
              title={entry.detail ? JSON.stringify(entry.detail) : undefined}
            >
              <span className="log-time">{formatTime(entry.timestamp)}</span>
              <span className={`log-level lvl-${entry.level}`}>{entry.level}</span>
              <span className="log-msg">
                <b>[{entry.phase}]</b> {entry.message}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}
