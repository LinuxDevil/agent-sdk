import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { CanvasToolbar, useUndoRedoShortcuts } from '../CanvasArea';

/**
 * The canvas toolbar's Undo/Redo buttons (C20): disabled with a
 * 'Nothing to …' reason until the history has a step, labelled
 * 'Undo <entry>' / 'Redo <entry>' when one does, ordered before
 * 'Auto layout' (PLAN §11). The window-level Ctrl/Cmd+Z / +Shift+Z / +Y
 * binding leaves editable targets to the field's native undo.
 */

type ToolbarProps = Parameters<typeof CanvasToolbar>[0];

function toolbarProps(over: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    canUndo: false,
    canRedo: false,
    undoLabel: '',
    redoLabel: '',
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    canDuplicate: true,
    readOnly: false,
    layoutBusy: false,
    onAutoLayout: vi.fn(),
    onFitView: vi.fn(),
    onDuplicate: vi.fn(),
    ...over,
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(found, `button '${label}'`).not.toBeNull();
  return found!;
}

describe('CanvasToolbar undo/redo buttons', () => {
  it('disables both with the reason until the history has a step', () => {
    const container = render(<CanvasToolbar {...toolbarProps()} />);
    const undo = button(container, 'Undo');
    const redo = button(container, 'Redo');
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    expect(undo.title).toBe('Nothing to undo');
    expect(redo.title).toBe('Nothing to redo');
  });

  it('enables and labels the buttons with the next step, and calls back', () => {
    const props = toolbarProps({ canUndo: true, canRedo: true, undoLabel: 'Move', redoLabel: 'Edit' });
    const container = render(<CanvasToolbar {...props} />);
    const undo = button(container, 'Undo Move');
    const redo = button(container, 'Redo Edit');
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(false);
    expect(undo.title).toBe('Undo Move');
    expect(redo.title).toBe('Redo Edit');
    act(() => undo.click());
    act(() => redo.click());
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).toHaveBeenCalledTimes(1);
  });

  it('renders Undo and Redo before Auto layout', () => {
    const container = render(<CanvasToolbar {...toolbarProps()} />);
    const labels = [...container.querySelectorAll('.canvas-toolbar button')].map((b) =>
      b.getAttribute('aria-label')
    );
    expect(labels.slice(0, 3)).toEqual(['Undo', 'Redo', 'Auto layout']);
  });
});

function ShortcutsProbe({ undo, redo }: { undo: () => void; redo: () => void }) {
  useUndoRedoShortcuts(undo, redo);
  return null;
}

function keydown(target: EventTarget, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

describe('undo/redo keyboard shortcuts', () => {
  it('Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const container = render(<ShortcutsProbe undo={undo} redo={redo} />);
    keydown(container, { key: 'z', ctrlKey: true });
    keydown(container, { key: 'z', ctrlKey: true, shiftKey: true });
    keydown(container, { key: 'y', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it('is ignored inside an input, leaving the field its native undo', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const container = render(
      <div>
        <ShortcutsProbe undo={undo} redo={redo} />
        <input />
      </div>
    );
    const input = container.querySelector('input')!;
    keydown(input, { key: 'z', ctrlKey: true });
    keydown(input, { key: 'y', ctrlKey: true });
    keydown(input, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });
});
