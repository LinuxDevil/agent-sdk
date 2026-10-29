import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, rerender } from '../../ui/__tests__/render';
import { useAgentEdgeSelection, useFitOnLoad } from '../canvasResets';

beforeEach(() => {
  // Run each frame at once, so a fit lands inside the render's act().
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFitOnLoad', () => {
  const fit = vi.fn();
  let fitting = false;
  function Probe({ agentId, nodes }: { agentId: string; nodes: number }) {
    fitting = useFitOnLoad(agentId, nodes, nodes > 0, fit);
    return null;
  }
  beforeEach(() => fit.mockClear());

  it('fits once when an agent opens, and again when another agent opens', () => {
    render(<Probe agentId="a" nodes={3} />);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(fitting).toBe(false);
    rerender(<Probe agentId="a" nodes={4} />);
    expect(fit).toHaveBeenCalledTimes(1);
    rerender(<Probe agentId="b" nodes={2} />);
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('refits when the graph is emptied and then filled again (a template applied)', () => {
    render(<Probe agentId="a" nodes={3} />);
    expect(fit).toHaveBeenCalledTimes(1);
    rerender(<Probe agentId="a" nodes={0} />);
    expect(fit).toHaveBeenCalledTimes(1);
    rerender(<Probe agentId="a" nodes={4} />);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fitting).toBe(false);
  });

  it('never fits an empty graph', () => {
    render(<Probe agentId="a" nodes={0} />);
    expect(fit).not.toHaveBeenCalled();
    expect(fitting).toBe(false);
  });
});

describe('useAgentEdgeSelection', () => {
  let state: ReturnType<typeof useAgentEdgeSelection> = [undefined, () => undefined];
  function Probe({ agentId }: { agentId: string }) {
    state = useAgentEdgeSelection(agentId);
    return null;
  }

  it('keeps the selected edge while the agent stays open', () => {
    render(<Probe agentId="a" />);
    act(() => state[1]('e1'));
    expect(state[0]).toBe('e1');
    rerender(<Probe agentId="a" />);
    expect(state[0]).toBe('e1');
    act(() => state[1](undefined));
    expect(state[0]).toBeUndefined();
  });

  it('clears the selected edge when another agent opens', () => {
    render(<Probe agentId="a" />);
    act(() => state[1]('e1'));
    rerender(<Probe agentId="b" />);
    expect(state[0]).toBeUndefined();
    // and switching back does not bring the old selection back
    rerender(<Probe agentId="a" />);
    expect(state[0]).toBeUndefined();
  });
});
