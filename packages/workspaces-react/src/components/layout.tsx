import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { UiContainer, UiTabs } from 'lousho/workspaces/client';
import type { RenderContext } from '../context';

const CONTAINER_CLASS = { stack: 'lwr-stack', row: 'lwr-row', section: 'lwr-section', card: 'lwr-card' } as const;

export function Container({ node, ctx }: { node: UiContainer; ctx: RenderContext }): ReactElement {
  const items = node.children.map((child, index) => ctx.render(child, index));
  if (node.type === 'section') {
    return (
      <section className="lwr-section" aria-label={node.label}>
        {node.label !== undefined && <h2 className="lwr-heading">{node.label}</h2>}
        {items}
      </section>
    );
  }
  return (
    <div className={CONTAINER_CLASS[node.type]}>
      {node.label !== undefined && <p className="lwr-label">{node.label}</p>}
      {items}
    </div>
  );
}

function nextTab(key: string, at: number, count: number): number | undefined {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (at + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

export function Tabs({ node, ctx }: { node: UiTabs; ctx: RenderContext }): ReactElement {
  const [active, setActive] = useState(0);
  const base = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (index: number): void => {
    setActive(index);
    buttons.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextTab(event.key, active, node.tabs.length);
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };
  return (
    <div className="lwr-tabs">
      <div role="tablist" aria-label={node.label ?? 'Tabs'} onKeyDown={onKeyDown}>
        {node.tabs.map((tab, index) => (
          <button
            key={index}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${base}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => select(index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {node.tabs.map((tab, index) => (
        <div key={index} role="tabpanel" id={`${base}-panel-${index}`} aria-labelledby={`${base}-tab-${index}`} hidden={index !== active}>
          {index === active ? tab.children.map((child, at) => ctx.render(child, at)) : null}
        </div>
      ))}
    </div>
  );
}
