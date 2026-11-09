/**
 * The Agent Author's entry points (AA19): one tiny external store that lets
 * any screen ask the docked panel to open - Ctrl/Cmd+J, the nav trigger, the
 * agents list's "Describe with AI", the empty canvas, the command palette and
 * the agent header's "Change with AI" all funnel through {@link openAuthor}.
 *
 * `openAuthor` opens the dock (through the control the shell registers once
 * via {@link registerAuthorDock}) and queues the request; the mounted panel
 * consumes it exactly once through `takePendingOpen`, re-running its effect
 * on every call thanks to the `usePendingOpenVersion` counter (the same
 * take-pending + version-bump pattern Wakeel's assistant entry store uses,
 * research §1.1). A draft is composer text only - it is never sent.
 *
 * The module also holds the route-focus "cleared" flag: clearing the
 * composer chip marks it until the next new chat, so `useRouteFocus` stops
 * re-applying the agent on screen. It lives here (not in useRouteFocus) so
 * `AuthorChatContext` can reset it on `newChat` without an import cycle.
 */
import { useSyncExternalStore } from 'react';
import type { AuthorFocus } from '../../shared/authorWire';

/** One request to open the Author dock, queued for the panel to consume once. */
export interface OpenAuthorRequest {
  source: 'shortcut' | 'header' | 'agents-list' | 'empty-canvas' | 'palette' | 'agent-header';
  /** Switch the composer focus before opening. */
  focus?: AuthorFocus;
  /** Composer text, placed only when the composer is empty; never sent. */
  draft?: string;
  /** Focus the composer textarea; defaults to true. */
  focusComposer?: boolean;
  /** Start a new chat first (refused while a save runs). */
  newChat?: boolean;
}

/** The prefill "Describe with AI" entries share (research §1.1's CREATE_AGENT_DRAFT). */
export const CREATE_AGENT_DRAFT = 'Create an agent that ';

let pendingOpen: OpenAuthorRequest | null = null;
let openVersion = 0;
const listeners = new Set<() => void>();

/** The dock open/close the shell exposes to the entry points. */
export interface AuthorDockControl {
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

let dockControl: AuthorDockControl | null = null;

/**
 * The shell (AppShell) registers its dock here so `openAuthor`/`toggleAuthor`
 * can drive it from anywhere - including places with no React tree access to
 * `useDock`. Pass `null` on unmount.
 */
export function registerAuthorDock(control: AuthorDockControl | null): void {
  dockControl = control;
}

/**
 * Opens the dock and queues `request` for the panel's take-pending effect.
 * The latest request wins while the panel is closed (only one can be pending).
 */
export function openAuthor(request: OpenAuthorRequest): void {
  pendingOpen = request;
  openVersion += 1;
  for (const listener of listeners) listener();
  dockControl?.setOpen(true);
}

/** Reads and clears the pending open request; `null` when none is queued. */
export function takePendingOpen(): OpenAuthorRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOpenVersion(): number {
  return openVersion;
}

/**
 * A `useSyncExternalStore` counter that bumps on every {@link openAuthor} -
 * the panel keys its take-pending effect on it, so an open that arrives while
 * the panel is already open still re-runs the effect.
 */
export function usePendingOpenVersion(): number {
  return useSyncExternalStore(subscribe, getOpenVersion);
}

/**
 * Ctrl/Cmd+J: closed → opens the dock and queues a composer-focused open;
 * open → closes the dock (the conversation keeps streaming - closing is a
 * pause, not an end).
 */
export function toggleAuthor(): void {
  if (dockControl !== null && dockControl.isOpen()) {
    dockControl.setOpen(false);
    return;
  }
  openAuthor({ source: 'shortcut' });
}

let focusCleared = false;

/**
 * The composer chip's clear button calls this: route-driven focus stops
 * re-applying until the next new chat ({@link resetAuthorFocusCleared}).
 */
export function markAuthorFocusCleared(): void {
  focusCleared = true;
}

/** A new chat re-arms route focus (`AuthorChatContext.newChat` calls this). */
export function resetAuthorFocusCleared(): void {
  focusCleared = false;
}

/** Whether the user cleared the route-driven focus in this chat. */
export function authorFocusCleared(): boolean {
  return focusCleared;
}
