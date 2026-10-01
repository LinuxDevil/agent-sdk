import { describe, it, expect, vi } from 'vitest';
import { DebugSession, llmBreakpointKey, toolBreakpointKey } from '../debugController';

describe('DebugSession', () => {
  it('does not pause when no breakpoint matches and no step is armed', async () => {
    const onChange = vi.fn();
    const session = new DebugSession([], onChange);
    await session.hooks().onLLMRequest?.({ model: 'x', messages: [] });
    expect(onChange).not.toHaveBeenCalled();
    expect(session.snapshot().paused).toBe(false);
  });

  it('pauses at a matching llm:before breakpoint and resumes on continue()', async () => {
    const states: boolean[] = [];
    const session = new DebugSession([llmBreakpointKey('before')], (s) => states.push(s.paused));

    const hookPromise = session.hooks().onLLMRequest?.({ model: 'x', messages: [{ role: 'user', content: 'hi' } as any] });

    // Give the pause a tick to take effect before asserting/continuing.
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);
    expect(session.snapshot().atBreakpoint).toEqual({ phase: 'llm', boundary: 'before' });
    expect(session.snapshot().messages).toHaveLength(1);

    session.continue();
    await hookPromise;
    expect(session.snapshot().paused).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('pauses on tool:<name>:after breakpoints keyed by the tool call name', async () => {
    const session = new DebugSession([toolBreakpointKey('current-date', 'after')], () => {});
    const toolCall = { id: '1', type: 'function' as const, function: { name: 'current-date', arguments: '{}' } };

    const hookPromise = session.hooks().onToolResult?.(toolCall, undefined, 5);
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);
    session.continue();
    await hookPromise;
  });

  it('step() arms a one-shot pause at the next hook boundary regardless of breakpoints', async () => {
    const session = new DebugSession([], () => {});
    session.step();
    const hookPromise = session.hooks().onLLMRequest?.({ model: 'x', messages: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);
    session.continue();
    await hookPromise;

    // Step is one-shot: the next hook call does NOT pause again.
    const secondPromise = session.hooks().onLLMResponse?.({} as any, 1, {} as any);
    await secondPromise;
    expect(session.snapshot().paused).toBe(false);
  });

  it('setBreakpoints() updates the live set and notifies onChange', () => {
    const onChange = vi.fn();
    const session = new DebugSession([], onChange);
    session.setBreakpoints([llmBreakpointKey('after')]);
    expect(session.snapshot().breakpoints).toEqual(['llm:after']);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ breakpoints: ['llm:after'] }));
  });

  it('step() while already paused releases the current pause instead of stacking', async () => {
    const session = new DebugSession([llmBreakpointKey('before')], () => {});
    const hookPromise = session.hooks().onLLMRequest?.({ model: 'x', messages: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);
    session.step();
    await hookPromise;
    expect(session.snapshot().paused).toBe(false);
  });

  it('auto-resumes (and flags autoResumed) if nobody continues/steps before pauseTimeoutMs elapses', async () => {
    const states: Array<{ paused: boolean; autoResumed?: boolean }> = [];
    // A tiny pauseTimeoutMs stands in for an abandoned pause (e.g. the only
    // WS client disconnected) - this is the safety net that stops a run
    // staying paused forever with no way to resume it.
    const session = new DebugSession([llmBreakpointKey('before')], (s) => states.push({ paused: s.paused, autoResumed: s.autoResumed }), 15);

    const hookPromise = session.hooks().onLLMRequest?.({ model: 'x', messages: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(session.snapshot().paused).toBe(true);

    // Nobody calls continue()/step() - just wait past the timeout.
    await hookPromise;
    expect(session.snapshot().paused).toBe(false);
    expect(states.at(-1)).toEqual({ paused: false, autoResumed: true });
  });

  it('pauseTimeoutMs: 0 disables the safety net (pause never auto-resumes on its own)', async () => {
    const session = new DebugSession([llmBreakpointKey('before')], () => {}, 0);
    const hookPromise = session.hooks().onLLMRequest?.({ model: 'x', messages: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(session.snapshot().paused).toBe(true);
    session.continue();
    await hookPromise;
    expect(session.snapshot().paused).toBe(false);
  });
});
