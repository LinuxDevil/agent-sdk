import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, TriggerNodeData } from '../../../graph/v2/types';
import type { CatalogState } from '../../useCatalog';
import type { AgentListItem, CatalogTriggerType } from '../../../../shared/wireTypes';

const app = vi.hoisted(() => {
  const agents: AgentListItem[] = ['open-agent', 'triage', 'billing'].map((id) => ({
    id,
    name: id,
    description: '',
    model: 'mock/mock-1',
    enabled: true,
    labels: [],
    updatedAt: '',
    publishedVersion: null,
    counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  }));
  return {
    graph: undefined as Graph | undefined,
    selectedNodeId: 'trigger:t1',
    agentId: 'open-agent',
    agents,
    setGraph: vi.fn(),
  };
});

const catalogs = vi.hoisted(() => {
  const TRIGGERS: CatalogTriggerType[] = [
    {
      type: 'chat',
      title: 'Chat',
      description: 'Runs when someone sends the agent a message.',
      fieldsJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      runsUnder: ['dev', 'worker', 'studio'],
    },
    {
      type: 'cron',
      title: 'Schedule',
      description: 'Runs the agent on a cron schedule.',
      fieldsJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      runsUnder: ['dev', 'worker', 'studio'],
    },
    {
      type: 'webhook',
      title: 'Webhook',
      description: 'Runs when an HTTP POST arrives at the path.',
      fieldsJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      runsUnder: ['studio'],
    },
    {
      type: 'channel',
      title: 'Channel',
      description: 'Runs on messages from a chat platform.',
      fieldsJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      runsUnder: ['studio'],
    },
    {
      type: 'agent',
      title: 'After another agent',
      description: "Runs when another agent's run finishes.",
      fieldsJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      runsUnder: ['studio'],
    },
    // A catalog type outside the five PLAN kinds — the Inspector falls back to U13's schema form.
    {
      type: 'email' as CatalogTriggerType['type'],
      title: 'Email',
      description: 'Runs when an email arrives.',
      fieldsJsonSchema: {
        type: 'object',
        properties: { address: { type: 'string', title: 'Address', minLength: 1 } },
        required: ['address'],
        additionalProperties: false,
      },
      runsUnder: ['studio'],
    },
  ];
  return {
    triggers: { data: TRIGGERS, error: undefined, loading: false } as CatalogState<CatalogTriggerType[]>,
    refresh: vi.fn(),
  };
});

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    displayGraph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    agentId: app.agentId,
    agents: app.agents,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

vi.mock('../../useCatalog', () => ({
  useCatalog: () => catalogs.triggers,
  refreshCatalog: catalogs.refresh,
}));

function specOf(triggers: Record<string, unknown>[]): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', triggers } as unknown as AgentSpecV2;
}

let container: HTMLDivElement;

function renderInspector() {
  container = mount(<Inspector />);
}

/** Re-render so the Inspector sees the graph `setGraph` just produced. */
function flush() {
  act(() => rerender(<Inspector />));
}

function field<T extends Element = HTMLInputElement>(id: string): T {
  return container.querySelector(`#${id}`) as T;
}

function type(id: string, value: string) {
  act(() => {
    const el = field<HTMLInputElement | HTMLTextAreaElement>(id);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as TriggerNodeData).item;

function useTrigger(trigger: Record<string, unknown>, nodeId: string) {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf([trigger]));
}

beforeEach(() => {
  app.selectedNodeId = 'trigger:t1';
  app.graph = specToGraph(specOf([{ id: 't1', type: 'chat' }]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
  catalogs.triggers = { data: catalogs.triggers.data, error: undefined, loading: false };
});

describe('trigger Inspector: Type select', () => {
  it('lists the catalog rows with their runsUnder suffix and description titles', () => {
    renderInspector();
    const options = [...field<HTMLSelectElement>('node-trigger-type').querySelectorAll('option')];
    expect(options.map((o) => o.textContent)).toEqual([
      'Chat · Dev, worker, studio',
      'Schedule · Dev, worker, studio',
      'Webhook · Studio',
      'Channel · Studio',
      'After another agent · Studio',
      'Email · Studio',
    ]);
    expect(options[2].title).toBe('Runs when an HTTP POST arrives at the path.');
  });

  it('keeps the id and replaces the other fields on a type switch', () => {
    useTrigger({ id: 't1', type: 'cron', cron: '0 9 * * *', prompt: 'go' }, 'trigger:t1');
    renderInspector();
    choose('node-trigger-type', 'webhook');
    expect(item()).toStrictEqual({ id: 't1', type: 'webhook', path: '/hooks/t1', promptTemplate: '' });
    flush();
    choose('node-trigger-type', 'chat');
    expect(item()).toStrictEqual({ id: 't1', type: 'chat' });
  });
});

describe('trigger Inspector: Id field', () => {
  it('writes item.id', () => {
    renderInspector();
    type('node-trigger-id', 'morning');
    expect(item().id).toBe('morning');
  });

  it('flags an invalid id', () => {
    renderInspector();
    type('node-trigger-id', 'has space');
    flush();
    expect(container.textContent).toContain('The id can use letters, digits, dash or underscore');
  });

  it('flags an id another trigger already uses', () => {
    app.graph = specToGraph(specOf([
      { id: 't1', type: 'chat' },
      { id: 't2', type: 'chat' },
    ]));
    renderInspector();
    type('node-trigger-id', 't2');
    flush();
    expect(container.textContent).toContain('Another trigger uses this id');
  });
});

describe('trigger Inspector: chat', () => {
  it('shows only the help line', () => {
    renderInspector();
    expect(container.textContent).toContain(
      'Runs when someone messages the agent in Studio or over HTTP.',
    );
    expect(container.querySelector('#node-trigger-cron')).toBeNull();
  });
});

describe('trigger Inspector: cron form', () => {
  beforeEach(() => {
    useTrigger(
      { id: 't2', type: 'cron', cron: '0 9 * * 1-5', timezone: 'Europe/Amsterdam', prompt: 'Post the daily summary' },
      'trigger:t2',
    );
    renderInspector();
  });

  it('writes cron, timezone, prompt and sharedSession', () => {
    type('node-trigger-cron', '30 8 * * *');
    expect(item()).toMatchObject({ cron: '30 8 * * *' });
    type('node-trigger-timezone', 'America/New_York');
    expect(item()).toMatchObject({ timezone: 'America/New_York' });
    type('node-trigger-prompt', 'Standup notes');
    expect(item()).toMatchObject({ prompt: 'Standup notes' });
    act(() => {
      container.querySelector<HTMLButtonElement>('#node-trigger-shared-session')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(item()).toMatchObject({ sharedSession: true });
  });

  it('flags a cron expression that is not five fields', () => {
    type('node-trigger-cron', '0 9 *');
    flush();
    expect(container.textContent).toContain('Use five fields: minute hour day month weekday');
  });

  it('flags an unknown time zone', () => {
    type('node-trigger-timezone', 'Mars/Olympus');
    flush();
    expect(container.textContent).toContain('Unknown time zone');
  });

  it('offers the IANA zones through a datalist when the runtime lists them', () => {
    const list = container.querySelector('datalist#node-trigger-timezone-list');
    expect(list).not.toBeNull();
  });
});

describe('trigger Inspector: webhook form', () => {
  beforeEach(() => {
    useTrigger({ id: 't3', type: 'webhook', path: '/hooks/zendesk', promptTemplate: 'New: {{event.body.subject}}' }, 'trigger:t3');
    renderInspector();
  });

  it('flags a path without a leading slash', () => {
    type('node-trigger-path', 'hooks/x');
    flush();
    expect(container.textContent).toContain('Start with / and use letters, digits, dash or underscore');
  });

  it('writes a Studio secret reference (no plain-text mode)', () => {
    choose('node-trigger-secret-mode', 'secret');
    type('node-trigger-secret', 'zendesk-hmac');
    expect(item()).toMatchObject({ secret: { secret: 'zendesk-hmac' } });
    const modes = [...container.querySelectorAll<HTMLOptionElement>('#node-trigger-secret-mode option')].map(
      (o) => o.textContent,
    );
    expect(modes).not.toContain('Plain text');
  });

  it('writes the prompt template and the filter', () => {
    type('node-trigger-prompt-template', 'Ticket {{event.body.id}}');
    expect(item()).toMatchObject({ promptTemplate: 'Ticket {{event.body.id}}' });
    type('node-trigger-filter', "event.body.action == 'opened'");
    expect(item()).toMatchObject({ filter: "event.body.action == 'opened'" });
  });

  it('deletes the filter when its input is cleared', () => {
    useTrigger(
      { id: 't3', type: 'webhook', path: '/hooks/zendesk', promptTemplate: 'x', filter: 'true' },
      'trigger:t3',
    );
    renderInspector();
    type('node-trigger-filter', '');
    expect('filter' in item()).toBe(false);
  });
});

describe('trigger Inspector: channel form', () => {
  beforeEach(() => {
    useTrigger({ id: 't4', type: 'channel', channel: 'slack', secrets: {} }, 'trigger:t4');
    renderInspector();
  });

  const secretKeys = () =>
    [...container.querySelectorAll<HTMLInputElement>('.kv-row input[placeholder="Name"]')].map(
      (input) => input.value,
    );

  it('prefills the channel\'s required secret keys while the map is empty', () => {
    expect(secretKeys()).toEqual(['signingSecret', 'botToken']);
    expect(item()).toMatchObject({ secrets: {} });
  });

  it('reports a missing required key and writes the filled one', () => {
    choose('node-trigger-secrets-value-0-mode', 'env');
    const input = container.querySelector<HTMLInputElement>('.kv-row input[placeholder="GITHUB_TOKEN"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'SLACK_SIGNING');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(item()).toMatchObject({ secrets: { signingSecret: { env: 'SLACK_SIGNING' } } });
    flush();
    expect(container.textContent).toContain('Add botToken');
  });

  it('resets the secret rows when the channel changes', () => {
    // ChoiceField options are positional: 1 telegram, 2 slack, 3 github, 4 teams, 5 discord, 6 http.
    choose('node-trigger-channel', '1');
    expect(item()).toMatchObject({ channel: 'telegram', secrets: {} });
    flush();
    expect(secretKeys()).toEqual(['botToken', 'secretToken']);
  });
});

describe('trigger Inspector: agent chain form', () => {
  beforeEach(() => {
    useTrigger({ id: 't5', type: 'agent', after: 'triage', on: 'done', promptTemplate: '{{run.resultText}}' }, 'trigger:t5');
    renderInspector();
  });

  it('lists the workspace agents except the open one', () => {
    const values = [...field<HTMLSelectElement>('node-trigger-after').querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(values).toContain('triage');
    expect(values).toContain('billing');
    expect(values).not.toContain('open-agent');
  });

  it('writes after, on and promptTemplate', () => {
    choose('node-trigger-after', 'billing');
    expect(item()).toMatchObject({ after: 'billing' });
    // ChoiceField: 1 Finishes, 2 Fails, 3 Ends either way.
    choose('node-trigger-on', '2');
    expect(item()).toMatchObject({ on: 'error' });
    type('node-trigger-prompt-template', 'Follow up: {{run.resultText}}');
    expect(item()).toMatchObject({ promptTemplate: 'Follow up: {{run.resultText}}' });
  });
});

describe('trigger Inspector: schema form for a catalog-extra type', () => {
  it('renders the fieldsJsonSchema form for a type with no hand-written form', () => {
    useTrigger({ id: 't9', type: 'email', address: '' }, 'trigger:t9');
    renderInspector();
    const address = field<HTMLInputElement>('node-trigger-address');
    expect(address).not.toBeNull();
    type('node-trigger-address', 'alerts@example.com');
    expect(item()).toStrictEqual({ id: 't9', type: 'email', address: 'alerts@example.com' });
  });

  it('keeps the type selectable after switching to it', () => {
    renderInspector();
    choose('node-trigger-type', 'email');
    expect(item()).toStrictEqual({ id: 't1', type: 'email' });
    flush();
    expect(field<HTMLInputElement>('node-trigger-address')).not.toBeNull();
  });
});
