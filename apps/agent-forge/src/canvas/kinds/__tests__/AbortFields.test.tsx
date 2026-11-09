import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';
import { Inspector } from '../../../components/Inspector';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2, TriggerSpec } from '../../../graph/v2/specTypes';
import type { AbortNodeData, Graph } from '../../../graph/v2/types';
import { ABORT_VIEW } from '../abort';

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'abort:a1',
  setGraph: vi.fn(),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

const WEBHOOK: TriggerSpec = { id: 't1', type: 'webhook', path: '/hooks/x', promptTemplate: 'x' };
const CRON: TriggerSpec = { id: 't2', type: 'cron', cron: '0 9 * * *', prompt: 'go' };
const CHANNEL: TriggerSpec = {
  id: 't3',
  type: 'channel',
  channel: 'slack',
  secrets: { signingSecret: { secret: 's' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
};
const LISTENER = { id: 'a1', triggerId: 't1', when: "event.action == 'closed'", match: 'event.pr == run.event.pr', scope: 'both' };

function specOf(triggers: TriggerSpec[], abortListeners: Record<string, unknown>[] = [LISTENER]): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', triggers, abortListeners } as unknown as AgentSpecV2;
}

let container: HTMLDivElement;

function renderInspector() {
  container = mount(<Inspector />);
}

function flush() {
  act(() => rerender(<Inspector />));
}

function field<T extends Element = HTMLInputElement>(id: string): T {
  return container.querySelector(`#${id}`) as T;
}

function choose(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** React's controlled inputs need the native value setter before the input event. */
function type(id: string, value: string) {
  act(() => {
    const el = field<HTMLInputElement>(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === 'abort:a1')!.data as AbortNodeData).item;

beforeEach(() => {
  vi.restoreAllMocks();
  app.selectedNodeId = 'abort:a1';
  app.graph = specToGraph(specOf([WEBHOOK, CRON, CHANNEL]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('abort Inspector', () => {
  it('offers only webhook and channel triggers, labelled with the C12 title and id', () => {
    renderInspector();
    const select = field<HTMLSelectElement>('node-abort-trigger');
    const options = [...select.options].map((o) => ({ value: o.value, label: o.textContent }));
    expect(options).toEqual([
      { value: 't1', label: 'Webhook · t1' },
      { value: 't3', label: 'Slack · t3' },
    ]);
    expect(select.value).toBe('t1');
    expect(select.disabled).toBe(false);
  });

  it('writes triggerId when another watchable trigger is picked', () => {
    renderInspector();
    choose('node-abort-trigger', 't3');
    expect(item().triggerId).toBe('t3');
    flush();
    expect(field<HTMLSelectElement>('node-abort-trigger').value).toBe('t3');
  });

  it('disables the trigger select with the reason when no webhook or channel trigger exists', () => {
    app.graph = specToGraph(specOf([CRON], [{ ...LISTENER, triggerId: 't2' }]));
    renderInspector();
    const select = field<HTMLSelectElement>('node-abort-trigger');
    expect(select.disabled).toBe(true);
    expect(select.title).toBe('Add a webhook or channel trigger first');
  });

  it('flags the required fields while they are empty', () => {
    app.graph = specToGraph(
      specOf([WEBHOOK], [{ id: 'a1', triggerId: '', when: '', match: '', scope: 'both' }])
    );
    renderInspector();
    expect(container.querySelector('#node-abort-trigger')?.closest('.field')?.querySelector('.field-error')?.textContent).toBe(
      'Pick the trigger to watch'
    );
    expect(container.querySelector('#node-abort-when')?.closest('.field')?.querySelector('.field-error')?.textContent).toBe(
      'Write when an event should cancel runs'
    );
    expect(container.querySelector('#node-abort-match')?.closest('.field')?.querySelector('.field-error')?.textContent).toBe(
      'Write how to find the run to cancel'
    );
  });

  it('writes the when and match expressions', () => {
    renderInspector();
    type('node-abort-when', "event.action == 'opened'");
    expect(item().when).toBe("event.action == 'opened'");
    type('node-abort-match', 'event.pr == run.event.number');
    expect(item().match).toBe('event.pr == run.event.number');
  });

  it('writes scope through the Cancel choice, with no unset option', () => {
    renderInspector();
    const select = field<HTMLSelectElement>('node-abort-scope');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Waiting runs', 'Running runs', 'Both']);
    choose('node-abort-scope', '1'); // Waiting runs
    expect(item().scope).toBe('queued');
    flush();
    choose('node-abort-scope', '2'); // Running runs
    expect(item().scope).toBe('running');
  });

  it('writes the id and flags a duplicate', () => {
    app.graph = specToGraph(
      specOf([WEBHOOK], [
        LISTENER,
        { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' },
      ])
    );
    app.selectedNodeId = 'abort:a1#2';
    renderInspector();
    const idField = field<HTMLInputElement>('node-abort-id');
    expect(idField.closest('.field')?.querySelector('.field-error')?.textContent).toBe(
      'Another abort listener uses this id'
    );
  });
});

describe('abort palette entry', () => {
  it('is unavailable with the reason until a webhook or channel trigger exists', () => {
    const entry = ABORT_VIEW.palette[0];
    expect(entry.group).toBe('Start');
    expect(entry.label).toBe('Abort listener');
    const noTriggers = specToGraph(specOf([]));
    expect(entry.unavailable?.(noTriggers, 'agent')).toBe('Add a webhook or channel trigger first');
    expect(entry.unavailable?.(app.graph!, 'agent')).toBeUndefined();
  });

  it('creates a listener on the first watchable trigger with the next a id', () => {
    const entry = ABORT_VIEW.palette[0];
    const created = entry.create(app.graph!, 'agent');
    expect(created.kind).toBe('abort');
    expect((created.data as AbortNodeData).item).toStrictEqual({
      id: 'a2', // a1 is taken by the graph's existing listener
      triggerId: 't1',
      when: '',
      match: '',
      scope: 'both',
    });
  });
});
