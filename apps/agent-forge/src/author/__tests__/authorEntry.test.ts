import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { render } from '../../ui/__tests__/render';
import {
  CREATE_AGENT_DRAFT,
  authorFocusCleared,
  markAuthorFocusCleared,
  openAuthor,
  registerAuthorDock,
  resetAuthorFocusCleared,
  takePendingOpen,
  toggleAuthor,
  usePendingOpenVersion,
  type AuthorDockControl,
} from '../authorEntry';

/** A dock control whose open flag the test flips; setOpen calls are recorded. */
function fakeDock(initial = false) {
  const calls: boolean[] = [];
  let open = initial;
  const control: AuthorDockControl & { calls: boolean[] } = {
    calls,
    isOpen: () => open,
    setOpen(next: boolean) {
      calls.push(next);
      open = next;
    },
  };
  return control;
}

/** Reads the pending-open version into `seen` on every change. */
function VersionProbe({ seen }: { seen: number[] }) {
  seen.push(usePendingOpenVersion());
  return null;
}

afterEach(() => {
  registerAuthorDock(null);
  takePendingOpen(); // drain anything a test left queued
  resetAuthorFocusCleared();
});

describe('authorEntry open requests', () => {
  it('takePendingOpen returns the request once, then null', () => {
    const request = { source: 'header' as const };
    openAuthor(request);
    expect(takePendingOpen()).toEqual(request);
    expect(takePendingOpen()).toBeNull();
  });

  it('the latest openAuthor wins while one is still pending', () => {
    openAuthor({ source: 'header' });
    openAuthor({ source: 'palette', focus: { mode: 'create' } });
    expect(takePendingOpen()).toEqual({ source: 'palette', focus: { mode: 'create' } });
  });

  it('usePendingOpenVersion bumps on every openAuthor', () => {
    const seen: number[] = [];
    render(createElement(VersionProbe, { seen }));
    const before = seen.at(-1);
    act(() => openAuthor({ source: 'header' }));
    act(() => openAuthor({ source: 'palette' }));
    expect(seen.at(-1)).toBe((before ?? 0) + 2);
  });

  it('openAuthor opens the registered dock', () => {
    const dock = fakeDock();
    registerAuthorDock(dock);
    openAuthor({ source: 'header' });
    expect(dock.calls).toEqual([true]);
    expect(dock.isOpen()).toBe(true);
  });
});

describe('toggleAuthor (Ctrl/Cmd+J)', () => {
  it('closed → opens the dock and queues a composer-focused shortcut request', () => {
    const dock = fakeDock(false);
    registerAuthorDock(dock);
    toggleAuthor();
    expect(dock.calls).toEqual([true]);
    expect(takePendingOpen()).toEqual({ source: 'shortcut' });
  });

  it('open → closes the dock and queues nothing', () => {
    const dock = fakeDock(true);
    registerAuthorDock(dock);
    toggleAuthor();
    expect(dock.calls).toEqual([false]);
    expect(takePendingOpen()).toBeNull();
  });
});

describe('route-focus cleared flag', () => {
  it('marks on clear and re-arms on reset (the next new chat)', () => {
    expect(authorFocusCleared()).toBe(false);
    markAuthorFocusCleared();
    expect(authorFocusCleared()).toBe(true);
    resetAuthorFocusCleared();
    expect(authorFocusCleared()).toBe(false);
  });
});

describe('CREATE_AGENT_DRAFT', () => {
  it('is the shared "Describe with AI" prefill', () => {
    expect(CREATE_AGENT_DRAFT).toBe('Create an agent that ');
  });
});
