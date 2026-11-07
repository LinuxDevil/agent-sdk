import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { render as mount, rerender } from '../../../ui/__tests__/render';

import { Inspector } from '../../../components/Inspector';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../../AgentNode';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { AgentSpecV2, HookSpec } from '../../../graph/v2/specTypes';
import type { Graph, GraphNode, HookNodeData } from '../../../graph/v2/types';

// CodeMirror is mocked to a plain textarea: jsdom has no real editor, and the
// field only needs an onChange that hands back the edited string.
vi.mock('@uiw/react-codemirror', () => ({
  default: (props: {
    value: string;
    onChange: (value: string) => void;
    'aria-label'?: string;
  }) =>
    createElement('textarea', {
      'aria-label': props['aria-label'],
      value: props.value,
      onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    }),
}));

const app = vi.hoisted(() => ({
  graph: undefined as Graph | undefined,
  selectedNodeId: 'hook:h1',
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

const INLINE: HookSpec = {
  id: 'h1',
  inline: { name: 'hook', point: 'preToolCall', code: 'return ctx;' },
};
const FILE: HookSpec = { id: 'h1', file: 'hooks/loop-guard.ts' };

function specOf(hooks: HookSpec[], over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', hooks, ...over } as AgentSpecV2;
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

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const item = () => (app.graph!.nodes.find((n) => n.id === app.selectedNodeId)!.data as HookNodeData).item;
const inline = () => {
  const it = item();
  if (!('inline' in it)) throw new Error('expected an inline hook');
  return it.inline;
};

function useHook(hook: HookSpec, over: Record<string, unknown> = {}, nodeId = 'hook:h1') {
  app.selectedNodeId = nodeId;
  app.graph = specToGraph(specOf([hook], over));
}

/** The labels of the template buttons the Inspector currently offers. */
function templateButtons(): string[] {
  return [...container.querySelectorAll('.hook-templates button')].map((b) => b.textContent ?? '');
}

/** Mounts `node`'s card and answers the chip, title or one `.node-row` value. */
function cardRow(node: GraphNode, key: string): string | undefined {
  const Card = NODE_TYPES[flowNodeType(node.kind)];
  const data: CanvasNodeData = { graphNode: node };
  const props = { id: node.id, type: flowNodeType(node.kind), data, selected: false } as unknown as NodeProps;
  const card = mount(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>,
  );
  if (key === 'chip') return card.querySelector('.node-chip')?.textContent ?? undefined;
  if (key === 'title') return card.querySelector('.rf-node-title')?.textContent ?? undefined;
  return [...card.querySelectorAll('.node-row')]
    .find((r) => r.firstElementChild?.textContent === key)
    ?.querySelector('code')?.textContent ?? undefined;
}

beforeEach(() => {
  vi.restoreAllMocks();
  app.selectedNodeId = 'hook:h1';
  app.graph = specToGraph(specOf([INLINE]));
  app.setGraph.mockReset().mockImplementation((fn: (g: Graph) => Graph) => {
    app.graph = fn(app.graph!);
  });
});

describe('hook Inspector: source switch', () => {
  it('shows the file input for a file hook and the inline form for code', () => {
    useHook(FILE);
    renderInspector();
    expect(field('node-hook-file').value).toBe('hooks/loop-guard.ts');
    expect(container.querySelector('#node-hook-name')).toBeNull();
    choose('node-hook-source', '1'); // Code here
    expect(item()).toStrictEqual({ id: 'h1', inline: { name: 'hook', point: 'preToolCall', code: '' } });
    flush();
    expect(container.querySelector('#node-hook-file')).toBeNull();
    expect(field('node-hook-name').value).toBe('hook');
    choose('node-hook-source', '2'); // File
    expect(item()).toStrictEqual({ id: 'h1', file: '' });
  });

  it('flags a file outside the agent folder or without a .ts/.js extension', () => {
    useHook(FILE);
    renderInspector();
    type('node-hook-file', '../outside.py');
    expect(item()).toStrictEqual({ id: 'h1', file: '../outside.py' });
    flush();
    expect(container.textContent).toContain('Use a .ts or .js file inside the agent folder');
    type('node-hook-file', 'hooks/ok.ts');
    flush();
    expect(container.textContent).not.toContain('Use a .ts or .js file inside the agent folder');
  });
});

describe('hook Inspector: inline fields', () => {
  it('writes the name, point, code and id', () => {
    renderInspector();
    type('node-hook-name', 'audit-log');
    expect(inline().name).toBe('audit-log');
    choose('node-hook-point', '3'); // Before each model call
    expect(inline().point).toBe('preGenerate');
    type('node-hook-id', 'h7');
    expect(item().id).toBe('h7');
  });

  it('writes code through the editor', () => {
    renderInspector();
    const editor = container.querySelector('textarea[aria-label="Hook code"]') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        editor,
        'ctx.args.x = 1; return ctx;',
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(inline().code).toBe('ctx.args.x = 1; return ctx;');
  });

  it('shows the point help that matches the family', () => {
    renderInspector();
    expect(container.textContent).toContain('ctx has toolName, args');
    choose('node-hook-point', '4'); // After each model call
    flush();
    expect(container.textContent).toContain('ctx has messages and model');
  });

  it('writes enabled: false when switched off and deletes the key when on', () => {
    renderInspector();
    click(field('node-hook-enabled'));
    expect(inline().enabled).toBe(false);
    flush();
    click(field('node-hook-enabled'));
    expect('enabled' in inline()).toBe(false);
  });
});

describe('hook Inspector: templates', () => {
  it('offers only the templates of the current point', () => {
    renderInspector();
    expect(templateButtons()).toEqual(['redact-pii', 'rate-limit']);
    choose('node-hook-point', '2'); // After each tool call
    flush();
    expect(templateButtons()).toEqual(['audit-log']);
    choose('node-hook-point', '3'); // Before each model call
    flush();
    expect(templateButtons()).toEqual(['inject-context']);
    choose('node-hook-point', '4'); // After each model call
    flush();
    expect(templateButtons()).toEqual([]);
  });

  it('asks before replacing non-empty code and swaps name only while it is hook', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderInspector();
    click(container.querySelector('.hook-templates button')!);
    expect(confirm).toHaveBeenCalledWith('Replace the current code with redact-pii?');
    expect(inline().code).toContain('REDACTED');
    expect(inline().name).toBe('redact-pii');
  });

  it('keeps a custom name when a template is applied', () => {
    useHook({ id: 'h1', inline: { name: 'mine', point: 'preToolCall', code: '' } });
    renderInspector();
    click(container.querySelector('.hook-templates button')!);
    expect(inline().name).toBe('mine');
    expect(inline().code).toContain('REDACTED');
  });

  it('does nothing when the replace is refused and never asks on empty code', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderInspector();
    click(container.querySelector('.hook-templates button')!);
    expect(inline().code).toBe('return ctx;');
    confirm.mockClear();
    useHook({ id: 'h1', inline: { name: 'hook', point: 'preToolCall', code: '' } });
    renderInspector();
    click(container.querySelector('.hook-templates button')!);
    expect(confirm).not.toHaveBeenCalled();
    expect(inline().code).toContain('REDACTED');
  });
});

describe('hook card', () => {
  it('titles a file hook by its basename and chips file', () => {
    useHook(FILE);
    const node = app.graph!.nodes.find((n) => n.id === 'hook:h1')!;
    expect(cardRow(node, 'title')).toBe('loop-guard.ts');
    expect(cardRow(node, 'chip')).toBe('file');
  });

  it('titles an inline hook by name, chips the point and marks a disabled hook off', () => {
    useHook({ id: 'h1', inline: { name: 'redact-pii', point: 'preToolCall', code: 'x', enabled: false } });
    const node = app.graph!.nodes.find((n) => n.id === 'hook:h1')!;
    expect(cardRow(node, 'title')).toBe('redact-pii');
    expect(cardRow(node, 'chip')).toBe('before tool call');
    expect(cardRow(node, 'status')).toBe('off');
    useHook({ id: 'h1', inline: { name: 'redact-pii', point: 'postGenerate', code: 'x' } });
    const on = app.graph!.nodes.find((n) => n.id === 'hook:h1')!;
    expect(cardRow(on, 'chip')).toBe('after model call');
    expect(cardRow(on, 'status')).toBeUndefined();
  });
});
