import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { graphToSpec } from '../../../graph/v2/graphToSpec';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../../graph/v2/specTypes';
import type { Graph, McpNodeData, PermissionNodeData } from '../../../graph/v2/types';
import { runtimeClient } from '../../../runtime/runtimeClient';
import type { AgentListItem, McpProbeTool } from '../../../../shared/wireTypes';

const app = vi.hoisted(() => {
  const agents: AgentListItem[] = ['open-agent'].map((id) => ({
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
    selectedNodeId: 'mcp:github',
    agentId: 'open-agent',
    agents,
    setGraph: vi.fn(),
  };
});

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    graph: app.graph,
    setGraph: app.setGraph,
    selectedNodeId: app.selectedNodeId,
    agentId: app.agentId,
    agents: app.agents,
    debugMode: false,
    debugState: undefined,
    setBreakpoints: vi.fn(),
  }),
}));

const PROBE_TOOLS: McpProbeTool[] = [
  { name: 'create_issue', description: 'Creates an issue' },
  { name: 'delete_repo', description: 'Deletes a repository' },
];

function specOf(mcpServers: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', mcpServers } as AgentSpecV2;
}

let container: HTMLDivElement;

function renderInspector() {
  container = mount(<Inspector />);
}

/** Re-render so the Inspector sees the graph `setGraph` just produced. */
function flush() {
  act(() => rerender(<Inspector />));
}

const asyncFlush = () => act(async () => {});

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

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function nodeData(id: string): McpNodeData {
  return app.graph!.nodes.find((n) => n.id === id)!.data as McpNodeData;
}

const item = () => nodeData(app.selectedNodeId).item;

function useServer(mcpServers: Record<string, unknown>, nodeId: string) {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf(mcpServers));
}

beforeEach(() => {
  app.selectedNodeId = 'mcp:github';
  app.graph = specToGraph(specOf({ github: { command: 'npx' } }));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Transport option indexes: 1 = Local command (stdio), 2 = Remote URL (http).
describe('mcp Inspector: transport switch', () => {
  const fullStdio = {
    command: 'npx',
    args: ['-y', 'server'],
    env: { GITHUB_TOKEN: { secret: 'gh' } },
    cwd: 'servers/gh',
    stderr: 'capture',
    approval: 'never',
    deferLoading: true,
    timeoutMs: 5000,
    connectTimeoutMs: 2000,
    tools: { exclude: ['delete_repo'] },
    optional: true,
  };

  it('keeps approval, timeouts, tools filter and the switches, drops stdio-only fields', () => {
    useServer({ github: fullStdio }, 'mcp:github');
    renderInspector();
    choose('node-mcp-transport', '2');
    expect(item()).toStrictEqual({
      url: '',
      approval: 'never',
      deferLoading: true,
      timeoutMs: 5000,
      connectTimeoutMs: 2000,
      tools: { exclude: ['delete_repo'] },
      optional: true,
    });
  });

  it('keeps the same fields switching back, dropping http-only fields', () => {
    useServer(
      {
        github: {
          url: 'https://mcp.linear.app/sse',
          headers: { Authorization: { env: 'LIN' } },
          oauth: { redirectUri: 'https://app.example.com/cb' },
          approval: 'annotations',
          timeoutMs: 5000,
          tools: { exclude: ['x'] },
        },
      },
      'mcp:github',
    );
    renderInspector();
    choose('node-mcp-transport', '1');
    expect(item()).toStrictEqual({
      command: '',
      approval: 'annotations',
      timeoutMs: 5000,
      tools: { exclude: ['x'] },
    });
  });
});

describe('mcp Inspector: name and stdio fields', () => {
  it('writes the record key and flags an invalid one', () => {
    renderInspector();
    type('node-mcp-key', 'bad key!');
    flush();
    expect(container.textContent).toContain('Use letters, digits, dash or underscore');
    type('node-mcp-key', 'github2');
    expect(nodeData('mcp:github').key).toBe('github2');
  });

  it('writes the command and flags an empty one', () => {
    renderInspector();
    type('node-mcp-command', 'uvx');
    expect(item()).toStrictEqual({ command: 'uvx' });
    type('node-mcp-command', '');
    flush();
    expect(container.textContent).toContain('Enter the command that starts the server');
  });

  it('writes env rows with secret refs', () => {
    renderInspector();
    click(field('node-mcp-env')); // the Add button when the map is empty
    type('node-mcp-env', 'GITHUB_TOKEN');
    choose('node-mcp-env-value-0-mode', 'secret');
    const input = container.querySelector<HTMLInputElement>('.kv-row input[placeholder="Secret name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'gh-token');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(item()).toStrictEqual({ command: 'npx', env: { GITHUB_TOKEN: { secret: 'gh-token' } } });
  });

  it('writes args, cwd and stderr', () => {
    renderInspector();
    type('node-mcp-args', '-y, server');
    flush(); // the emitted first item must render before Enter adds the second
    act(() => {
      field<HTMLInputElement>('node-mcp-args').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    type('node-mcp-cwd', 'servers/gh');
    choose('node-mcp-stderr', '2'); // Capture
    expect(item()).toStrictEqual({ command: 'npx', args: ['-y', 'server'], cwd: 'servers/gh', stderr: 'capture' });
  });
});

describe('mcp Inspector: http fields and OAuth', () => {
  beforeEach(() => {
    useServer({ linear: { url: 'https://mcp.linear.app/sse' } }, 'mcp:linear');
  });

  it('flags an invalid URL and writes a valid one', () => {
    renderInspector();
    type('node-mcp-url', 'not a url');
    flush();
    expect(container.textContent).toContain('Enter the server URL');
    type('node-mcp-url', 'https://mcp.example.com/mcp');
    expect(item()).toStrictEqual({ url: 'https://mcp.example.com/mcp' });
  });

  it('toggles OAuth on, writes the redirect URI and the client id', () => {
    renderInspector();
    click(field<HTMLButtonElement>('node-mcp-oauth'));
    expect(item()).toMatchObject({ oauth: { redirectUri: '' } });
    flush(); // the OAuth sub-fields render only once item.oauth is set
    type('node-mcp-oauth-redirect', 'https://app.example.com/cb');
    flush(); // patchOauth merges the live oauth prop — render the redirect write first
    type('node-mcp-oauth-client-id', 'client-1');
    expect(item()).toMatchObject({ url: 'https://mcp.linear.app/sse', oauth: { redirectUri: 'https://app.example.com/cb', clientId: 'client-1' } });
    click(field<HTMLButtonElement>('node-mcp-oauth'));
    expect(item()).toStrictEqual({ url: 'https://mcp.linear.app/sse' });
  });

  it('flags a client secret without a client id', () => {
    useServer(
      { linear: { url: 'https://mcp.linear.app/sse', oauth: { redirectUri: 'https://a/cb', clientSecret: { secret: 's' } } } },
      'mcp:linear',
    );
    renderInspector();
    expect(container.textContent).toContain('Set the client id first');
  });
});

describe('mcp Inspector: behaviour fields', () => {
  it('writes approval, deferLoading, optional and the timeouts', () => {
    renderInspector();
    choose('node-mcp-approval', '1'); // Use the server's tool hints
    click(field<HTMLButtonElement>('node-mcp-defer'));
    click(field<HTMLButtonElement>('node-mcp-optional'));
    type('node-mcp-timeout', '5000');
    type('node-mcp-connect-timeout', '2000');
    expect(item()).toStrictEqual({
      command: 'npx',
      approval: 'annotations',
      deferLoading: true,
      optional: true,
      timeoutMs: 5000,
      connectTimeoutMs: 2000,
    });
  });
});

describe('mcp Inspector: probe', () => {
  it('is disabled while the command is invalid', () => {
    useServer({ github: { command: '' } }, 'mcp:github');
    renderInspector();
    const button = field<HTMLButtonElement>('node-mcp-probe');
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Fix the errors above first');
  });

  it('lists the tools a successful probe returns', async () => {
    useServer({ github: { command: 'probe-ok-1' } }, 'mcp:github');
    vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: true, tools: PROBE_TOOLS });
    renderInspector();
    click(field<HTMLButtonElement>('node-mcp-probe'));
    await asyncFlush();
    flush();
    const names = [...container.querySelectorAll('.mcp-tool-name')].map((el) => el.textContent);
    expect(names).toEqual(['create_issue', 'delete_repo']);
  });

  it('shows the alert when the server cannot be reached', async () => {
    useServer({ github: { command: 'probe-fail-1' } }, 'mcp:github');
    vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: false, error: 'spawn probe-fail-1 ENOENT' });
    renderInspector();
    click(field<HTMLButtonElement>('node-mcp-probe'));
    await asyncFlush();
    flush();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('Could not reach the server: spawn probe-fail-1 ENOENT');
  });

  it('unchecking Allowed writes tools.exclude, checking it again removes it', async () => {
    useServer({ github: { command: 'probe-allow-1' } }, 'mcp:github');
    vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: true, tools: PROBE_TOOLS });
    renderInspector();
    click(field<HTMLButtonElement>('node-mcp-probe'));
    await asyncFlush();
    flush();
    const allowedBox = () =>
      [...container.querySelectorAll('.mcp-tool')]
        .find((el) => el.querySelector('.mcp-tool-name')!.textContent === 'delete_repo')!
        .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0];
    click(allowedBox()); // Allowed off
    expect(item()).toMatchObject({ tools: { exclude: ['delete_repo'] } });
    // The toggle rewrote item.tools, so the probe cache re-keyed and the
    // list went idle — probe the edited server to list its tools again.
    flush();
    click(field<HTMLButtonElement>('node-mcp-probe'));
    await asyncFlush();
    flush();
    click(allowedBox()); // Allowed on
    expect(item()).toStrictEqual({ command: 'probe-allow-1' });
  });

  it('checking Ask first adds a perm node and the permissions entry, unchecking removes it', async () => {
    useServer({ github: { command: 'probe-ask-1' } }, 'mcp:github');
    vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: true, tools: PROBE_TOOLS });
    renderInspector();
    click(field<HTMLButtonElement>('node-mcp-probe'));
    await asyncFlush();
    flush();
    const askBox = () =>
      [...container.querySelectorAll('.mcp-tool')]
        .find((el) => el.querySelector('.mcp-tool-name')!.textContent === 'create_issue')!
        .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    click(askBox()); // Ask first on
    const perm = app.graph!.nodes.find((n) => n.kind === 'permission')!;
    expect(perm.id).toBe('perm:p1');
    expect(perm.owner).toBe('agent');
    expect(perm.data as PermissionNodeData).toStrictEqual({
      item: { id: 'p1', tool: 'github__create_issue', action: 'ask' },
    });
    expect(graphToSpec(app.graph!).spec.permissions).toStrictEqual([
      { id: 'p1', tool: 'github__create_issue', action: 'ask' },
    ]);
    flush();
    click(askBox()); // Ask first off
    expect(app.graph!.nodes.filter((n) => n.kind === 'permission')).toEqual([]);
    expect(graphToSpec(app.graph!).spec.permissions).toBeUndefined();
  });
});
