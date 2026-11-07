import { Bot } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { render as mount } from './render';

import { overflowEdges, Tabs, type TabItem } from '../Tabs';

let container: HTMLDivElement;
const render = (node: React.ReactNode) => {
  container = mount(node);
};

const ITEMS: TabItem[] = [
  { id: 'overview', label: 'Overview', href: '#/agents/x/overview' },
  { id: 'runs', label: 'Runs', href: '#/agents/x/runs', count: 12 },
  { id: 'versions', label: 'Versions', href: '#/agents/x/versions', disabled: true, disabledReason: 'Coming soon' },
];

describe('Tabs', () => {
  it('renders links, marks the current tab, draws a count pill and a disabled placeholder', () => {
    render(<Tabs label="Agent" items={ITEMS} currentId="runs" />);
    const strip = container.querySelector('nav.tabs-strip[aria-label="Agent"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.dataset.overflow).toBe('none');

    const links = [...strip.querySelectorAll('a.tabs-tab')];
    expect(links).toHaveLength(2);
    const runs = strip.querySelector('a.tabs-tab[data-tab-id="runs"]') as HTMLAnchorElement;
    expect(runs.getAttribute('aria-current')).toBe('page');
    expect(runs.getAttribute('href')).toBe('#/agents/x/runs');

    const count = runs.querySelector('.tabs-count') as HTMLElement;
    expect(count.classList.contains('tabular-nums')).toBe(true);
    expect(count.textContent).toBe(', 12');
    expect(count.querySelector('.visually-hidden')?.textContent).toBe(', ');
    expect(count.lastChild?.textContent).toBe('12');

    const versions = strip.querySelector('span.tabs-tab-disabled[data-tab-id="versions"]') as HTMLElement;
    expect(versions).not.toBeNull();
    expect(versions.tagName).toBe('SPAN');
    expect(versions.getAttribute('aria-disabled')).toBe('true');
    expect(versions.getAttribute('title')).toBe('Coming soon');
    expect(versions.getAttribute('href')).toBeNull();
    expect(versions.getAttribute('tabindex')).toBeNull();
    expect(versions.getAttribute('aria-current')).toBeNull();
  });

  it('marks nothing when the current id belongs to a disabled tab', () => {
    render(<Tabs label="Agent" items={ITEMS} currentId="versions" />);
    expect(container.querySelector('[aria-current]')).toBeNull();
  });

  it('renders the trailing slot only when given one', () => {
    render(<Tabs label="Agent" items={ITEMS} currentId="runs" trailing={<span id="chips" />} />);
    expect(container.querySelector('.tabs-trailing #chips')).not.toBeNull();

    render(<Tabs label="Agent" items={ITEMS} currentId="runs" />);
    expect(container.querySelector('.tabs-trailing')).toBeNull();
  });

  it('draws a 14px decorative icon before the label', () => {
    const items: TabItem[] = [{ id: 'a', label: 'Agents', href: '#/agents', icon: Bot }];
    render(<Tabs label="Agent" items={items} currentId="a" />);
    const tab = container.querySelector('a.tabs-tab') as HTMLElement;
    const svg = tab.querySelector('svg[aria-hidden="true"]') as SVGElement;
    expect(svg).not.toBeNull();
    const label = tab.querySelector('.tabs-label') as HTMLElement;
    expect(svg.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(label.textContent).toBe('Agents');
  });
});

describe('overflowEdges', () => {
  it('reports which edges hide scrolled-off content, with a 1px tolerance', () => {
    expect(overflowEdges(0, 100, 100)).toBe('none');
    expect(overflowEdges(0, 100, 300)).toBe('end');
    expect(overflowEdges(200, 100, 300)).toBe('start');
    expect(overflowEdges(199.5, 100, 300)).toBe('start');
    expect(overflowEdges(50, 100, 300)).toBe('both');
  });
});
