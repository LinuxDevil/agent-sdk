import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../ui/__tests__/render';

import { useMcpProbe } from '../mcp/useMcpProbe';
import { runtimeClient } from '../../../runtime/runtimeClient';
import type { McpServerSpecV2 } from '../../../../shared/wireTypes';

const TOOLS = [
  { name: 'create_issue', description: 'Creates an issue' },
  { name: 'delete_repo', description: 'Deletes a repository' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

let container: HTMLDivElement;

/** Renders the hook's state as text so the DOM tells us which phase it is in. */
function Probe({ server }: { server: McpServerSpecV2 }): JSX.Element {
  const probe = useMcpProbe(server);
  return (
    <div>
      <button type="button" className="go" onClick={() => probe.probe()} />
      <div className="state">{probe.state}</div>
      <div className="tools">{(probe.tools ?? []).map((tool) => tool.name).join(',')}</div>
      <div className="error">{probe.error ?? ''}</div>
    </div>
  );
}

const flush = () => act(async () => {});

function click(): void {
  act(() => {
    container.querySelector<HTMLButtonElement>('.go')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function text(selector: string): string | null {
  return container.querySelector(selector)?.textContent ?? null;
}

describe('useMcpProbe', () => {
  it('starts idle, lists the tools a successful probe returned', async () => {
    const spy = vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: true, tools: TOOLS });
    container = render(<Probe server={{ command: 'probe-ok-a' }} />);
    expect(text('.state')).toBe('idle');
    click();
    expect(text('.state')).toBe('probing');
    await flush();
    expect(text('.state')).toBe('done');
    expect(text('.tools')).toBe('create_issue,delete_repo');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ command: 'probe-ok-a' });
  });

  it('serves a second probe of the same server from the cache', async () => {
    const spy = vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: true, tools: TOOLS });
    container = render(<Probe server={{ command: 'probe-ok-b' }} />);
    click();
    await flush();
    click();
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(text('.state')).toBe('done');
    expect(text('.tools')).toBe('create_issue,delete_repo');
  });

  it('shares one in-flight probe between two callers of the same server', async () => {
    const spy = vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: true, tools: TOOLS });
    container = render(
      <>
        <Probe server={{ command: 'probe-ok-c' }} />
        <Probe server={{ command: 'probe-ok-c' }} />
      </>,
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.go')];
    act(() => {
      for (const button of buttons) button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers the error state when the server cannot be reached', async () => {
    vi.spyOn(runtimeClient, 'probeMcp').mockResolvedValue({ ok: false, error: 'spawn probe-fail ENOENT' });
    container = render(<Probe server={{ command: 'probe-fail-a' }} />);
    click();
    await flush();
    expect(text('.state')).toBe('error');
    expect(text('.error')).toBe('spawn probe-fail ENOENT');
  });

  it('answers the error state when the request itself throws', async () => {
    vi.spyOn(runtimeClient, 'probeMcp').mockRejectedValue(new Error('network down'));
    container = render(<Probe server={{ command: 'probe-throw-a' }} />);
    click();
    await flush();
    expect(text('.state')).toBe('error');
    expect(text('.error')).toBe('network down');
  });
});
