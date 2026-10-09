import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from '../ErrorBoundary';
import { agentIdProblem } from '../../../shared/agentId';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new TypeError('n.filter is not a function');
}

describe('ErrorBoundary (Eve DUI-F3)', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it('shows the error and a way out instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      )
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('n.filter is not a function');
    expect(container.textContent).toContain('Reload');
  });
});

describe('agentIdProblem (Eve DUI-F3)', () => {
  it('matches the server rule and explains a bad name', () => {
    expect(agentIdProblem('my-agent_1.v2')).toBeUndefined();
    expect(agentIdProblem('My Agent')).toMatch(/no spaces/);
    expect(agentIdProblem('hi!')).toMatch(/letters, digits/);
    expect(agentIdProblem('-x')).toMatch(/Start with/);
    expect(agentIdProblem('a..b')).toMatch(/\.\./);
    expect(agentIdProblem('a'.repeat(129))).toMatch(/128/);
  });
});
