import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';

const appState = vi.hoisted(() => ({ runStatus: { status: 'running' } as { status: string } | null }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { ScreenHeader, ScreenHeaderHost } from '../ScreenHeader';

const h1s = () => [...document.querySelectorAll('h1')].map((h) => h.textContent);

/** A screen that shows its own header while `on`, with a counter proving its state reaches the portal. */
function Screen({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [count, setCount] = useState(0);
  return (
    <main>
      <button type="button" id="toggle" onClick={() => setOn((v) => !v)}>
        toggle
      </button>
      {on && (
        <ScreenHeader
          title="Datasets"
          description="Examples to evaluate"
          status={null}
          breadcrumbs={[{ label: 'Evaluations', href: '#/evals/scores' }, { label: 'Datasets' }]}
          actions={
            <button type="button" id="action" onClick={() => setCount((n) => n + 1)}>
              Clicked {count}
            </button>
          }
        />
      )}
    </main>
  );
}

describe('ScreenHeader', () => {
  it('defaults to the active nav label and the live run status', () => {
    window.location.hash = '#/evals/datasets';
    appState.runStatus = { status: 'running' };
    render(
      <ScreenHeaderHost>
        <main />
      </ScreenHeaderHost>,
    );
    expect(h1s()).toEqual(['Evaluations']);
    const status = document.querySelector('.page-header-status [role="status"][aria-live="polite"]');
    expect(status?.textContent).toContain('running');
    expect(document.querySelector('header .page-header-status')).not.toBeNull();
  });

  it('a nested ScreenHeader replaces the default; unmounting it restores the default', () => {
    window.location.hash = '#/evals/datasets';
    const el = render(
      <ScreenHeaderHost>
        <Screen initial />
      </ScreenHeaderHost>,
    );
    expect(h1s()).toEqual(['Datasets']);
    expect(document.querySelectorAll('header.page-header')).toHaveLength(1);
    // Rendered in the header slot (outside main), with the screen's own props.
    const header = el.querySelector('.screen-header header')!;
    expect(header.querySelector('.page-header-description')?.textContent).toBe('Examples to evaluate');
    expect(header.querySelector('nav[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent).toBe('Datasets');
    expect(header.querySelector('.page-header-status')).toBeNull();
    expect(el.querySelector('main header')).toBeNull();

    // The screen's state still drives the portalled actions.
    act(() => (document.getElementById('action') as HTMLButtonElement).click());
    expect(document.getElementById('action')?.textContent).toBe('Clicked 1');

    act(() => (document.getElementById('toggle') as HTMLButtonElement).click());
    expect(h1s()).toEqual(['Evaluations']);
    expect(document.querySelectorAll('header.page-header')).toHaveLength(1);

    act(() => (document.getElementById('toggle') as HTMLButtonElement).click());
    expect(h1s()).toEqual(['Datasets']);
  });

  it('renders inline outside a host', () => {
    window.location.hash = '#/traces';
    appState.runStatus = null;
    render(<ScreenHeader />);
    expect(h1s()).toEqual(['Traces']);
    expect(document.querySelector('.page-header-status')?.textContent).toContain('idle');
  });
});
