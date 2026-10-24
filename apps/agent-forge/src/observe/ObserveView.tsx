import './observe.css';
import { useState } from 'react';
import { tabIds, tabListKeyDown } from '../components/tabs';
import { useDaemonHealth } from './useObserve';
import { ObserveDaemonDown } from './chrome';
import type { TraceListFilter } from './observeClient';
import { TracesPanel } from './TracesPanel';
import { TraceDetailView } from './TraceDetailView';
import { InsightsPanel } from './InsightsPanel';
import { FleetPanel } from './FleetPanel';
import { ScoresPanel } from './ScoresPanel';

const TABS = [
  { id: 'traces', label: 'Traces' },
  { id: 'insights', label: 'Insights' },
  { id: 'fleet', label: 'Monitoring' },
  { id: 'scores', label: 'Scores' },
] as const;
type ObserveTab = (typeof TABS)[number]['id'];
const TAB_IDS: ObserveTab[] = TABS.map((t) => t.id);

/**
 * The observability surface - Traces, Insights, Monitoring (fleet) and
 * Scores - served by the observe daemon's read API through the same-origin
 * `/observe` proxy. Cross-panel drill-down (fleet row -> that agent's
 * traces) is just shared state here: `tracesFilter` is owned at the top so
 * another tab can pre-fill it.
 */
export function ObserveView() {
  const health = useDaemonHealth();
  const [tab, setTab] = useState<ObserveTab>('traces');
  const [tracesFilter, setTracesFilter] = useState<TraceListFilter>({});
  const [traceId, setTraceId] = useState<string | undefined>(undefined);

  // Monitoring's "view traces" click-through: same table, scoped to the agent.
  const drillToAgent = (agentId: string) => {
    setTracesFilter((filter) => ({ ...filter, agent_id: agentId }));
    setTraceId(undefined);
    setTab('traces');
  };
  const drillToTrace = (id: string) => {
    setTraceId(id);
    setTab('traces');
  };

  let body: React.ReactNode;
  if (health.down) body = <ObserveDaemonDown />;
  else if (tab === 'traces' && traceId !== undefined)
    body = <TraceDetailView traceId={traceId} onBack={() => setTraceId(undefined)} />;
  else if (tab === 'traces')
    body = (
      <TracesPanel
        filter={tracesFilter}
        onFilterChange={(filter) => {
          setTracesFilter(filter);
          setTraceId(undefined);
        }}
        onOpenTrace={setTraceId}
      />
    );
  else if (tab === 'insights') body = <InsightsPanel />;
  else if (tab === 'fleet') body = <FleetPanel onShowTraces={drillToAgent} />;
  else body = <ScoresPanel onOpenTrace={drillToTrace} />;

  const ids = tabIds('observe', tab);
  return (
    <section className="observe" aria-label="Observability">
      <div
        className="observe-tabs"
        role="tablist"
        aria-label="Observability panels"
        onKeyDown={tabListKeyDown('observe', TAB_IDS, tab, setTab)}
      >
        {TABS.map((t) => {
          const selected = tab === t.id;
          const tids = tabIds('observe', t.id);
          return (
            <button
              key={t.id}
              id={tids.tab}
              role="tab"
              aria-selected={selected}
              aria-controls={tids.panel}
              tabIndex={selected ? 0 : -1}
              className={`observe-tab${selected ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="observe-body" id={ids.panel} role="tabpanel" aria-labelledby={ids.tab}>
        {body}
      </div>
    </section>
  );
}
