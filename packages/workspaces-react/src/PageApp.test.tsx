import axe from 'axe-core';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UI_COMPONENTS, type UiComponent } from 'lousho/workspaces';
import { PageApp } from './PageApp';
import { runWith, withAudience, withUi } from './__tests__/clients';
import { choose, flush, labelled, render } from './__tests__/render';

async function mount(client = withAudience(), run = runWith({ script: '# Hook\n\nThree beats.' })): Promise<HTMLDivElement> {
  const container = render(<PageApp client={client} workspaceId="marketing" pageId="instagram-videos" run={run} />);
  await flush();
  return container;
}

function sample(type: string): UiComponent {
  if (['stack', 'row', 'section', 'card'].includes(type)) return { type, children: [] } as unknown as UiComponent;
  if (type === 'tabs') return { type: 'tabs', tabs: [{ label: 'One', children: [] }] };
  if (['select', 'radio'].includes(type)) return { type, bind: 'inputs.tone' } as UiComponent;
  if (['text', 'textarea', 'number', 'slider', 'toggle', 'file', 'schemaForm'].includes(type)) return { type, bind: type === 'schemaForm' ? 'inputs' : 'inputs.topic' } as UiComponent;
  if (['markdown', 'json', 'table'].includes(type)) return { type, source: 'outputs.script' } as UiComponent;
  if (type === 'artifact') return { type: 'artifact', artifact: 'video' };
  return { type } as UiComponent;
}

describe('PageApp', () => {
  it('the instagram UI renders topic, duration, tone, audience, generate and script preview', async () => {
    const container = await mount();
    expect((labelled(container, 'Topic') as HTMLInputElement).type).toBe('text');
    expect((labelled(container, 'Duration in seconds') as HTMLInputElement).type).toBe('number');
    expect(labelled(container, 'Tone').tagName).toBe('SELECT');
    expect(labelled(container, 'Audience').tagName).toBe('SELECT');
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toContain('Generate');
    expect(container.textContent).toContain('Script');
    expect(container.textContent).toContain('# Hook');
  });

  it('visibleWhen hides and shows', async () => {
    const layout: UiComponent = {
      type: 'stack',
      children: [
        { type: 'select', bind: 'inputs.tone', label: 'Tone' },
        { type: 'section', label: 'Formal note', visibleWhen: "inputs.tone == 'formal'", children: [{ type: 'runStatus' }] },
      ],
    };
    const container = await mount(withUi(layout));
    expect(container.textContent).not.toContain('Formal note');
    choose(labelled(container, 'Tone'), 'formal');
    expect(container.textContent).toContain('Formal note');
    choose(labelled(container, 'Tone'), 'playful');
    expect(container.textContent).not.toContain('Formal note');
  });

  it('labels and model text render as text nodes (R15)', async () => {
    const markup = '<img src=x onerror=alert(1)>';
    const layout = { type: 'stack', label: markup, children: [{ type: 'markdown', source: 'outputs.script', label: markup }] } as UiComponent;
    const script = '<script>alert(1)</script> [x](javascript:alert(1))';
    const container = await mount(withUi(layout), runWith({ script }));
    expect(container.querySelector('img, script, a, iframe')).toBeNull();
    expect(container.textContent).toContain(markup);
    expect(container.textContent).toContain(script);
  });

  it('every catalog component has a renderer', async () => {
    const types = [...new Set(Object.values(UI_COMPONENTS).flat())];
    const container = await mount(withUi({ type: 'stack', children: types.map(sample) }));
    expect(container.textContent).not.toContain('Unsupported component');
  });

  it('an unknown type shows a placeholder and logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = await mount(withUi({ type: 'stack', children: [{ type: 'iframe' } as unknown as UiComponent] }));
    expect(container.textContent).toContain('Unsupported component: iframe');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"iframe"'));
    warn.mockRestore();
  });

  it('tabs move with the arrow keys', async () => {
    const layout: UiComponent = { type: 'tabs', tabs: [{ label: 'One', children: [] }, { label: 'Two', children: [] }] };
    const container = await mount(withUi(layout));
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0].focus();
    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const after = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(after.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(document.activeElement).toBe(after[1]);
  });

  it('shows the load error as text', async () => {
    const failing = { ...withAudience(), call: () => Promise.reject(new Error('<b>service down</b>')) } as unknown as Parameters<typeof PageApp>[0]['client'];
    const container = await mount(failing);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('<b>service down</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('the instagram UI has no axe violations', async () => {
    const container = await mount();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
