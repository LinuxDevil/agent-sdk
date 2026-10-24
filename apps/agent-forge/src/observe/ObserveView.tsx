import './observe.css';
import { useState } from 'react';
import { tabIds, tabListKeyDown } from '../components/tabs';
import { useDaemonHealth } from './useObserve';
import { ObserveDaemonDown } from './chrome';
import type { TraceListFilter } from './observeClient';
import { TracesPanel } from './TracesPanel';
import { TraceDetailView } from './TraceDetailView';
import { ScoresPanel } from './ScoresPanel';

const TABS = [
  { id: 'traces', label: 'Traces' },
  { id: 'scores', label: 'Scores' },
] as const;
export type ObserveTab = (typeof TABS)[number]['id'];
const TAB_IDS: ObserveTab[] = TABS.map((t) => t.id);

/**
 * The observability surface - Traces and Scores - served by the observe
 * daemon's read API through the same-origin `/observe` proxy. Cross-panel
 * drill-down (score row -> its trace) is just shared state here. Monitoring
 * (fleet + charts) is its own screen, `screens/monitoring`.
 *
 * Given `tab`, the route owns the panel: the tab strip is hidden (the left
 * nav is the only switcher) and drill-downs ask `onTabChange` to navigate.
 */
export function ObserveView({
  tab: routeTab,
  onTabChange,
}: { tab?: ObserveTab; onTabChange?: (tab: ObserveTab) => void } = {}) {
  const health = useDaemonHealth();
  const [ownTab, setOwnTab] = useState<ObserveTab>('traces');
  const routed = routeTab !== undefined;
  const tab = routeTab ?? ownTab;
  const setTab = (next: ObserveTab) => (routed ? onTabChange?.(next) : setOwnTab(next));
  const [tracesFilter, setTracesFilter] = useState<TraceListFilter>({});
  const [traceId, setTraceId] = useState<string | undefined>(undefined);

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
  else body = <ScoresPanel onOpenTrace={drillToTrace} />;

  if (routed)
    return (
      <section className="observe" aria-label="Observability">
        <div className="observe-body">{body}</div>
      </section>
    );

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
