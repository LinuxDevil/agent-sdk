import { describe, it, expect } from 'vitest';
import { isEditableTarget } from '../isEditableTarget';

/** Eve DUI-F10: Ctrl/Cmd+D inside a text field duplicated the selected node. */
describe('isEditableTarget (Eve DUI-F10)', () => {
  it('is true for fields and contenteditable (and anything inside them)', () => {
    document.body.innerHTML = `
      <input id="i" /><textarea id="t"></textarea><select id="s"></select>
      <div contenteditable="true"><span id="inside-ce">x</span></div>
      <div class="react-flow__pane" id="pane"></div>`;
    for (const id of ['i', 't', 's', 'inside-ce']) {
      expect(isEditableTarget(document.getElementById(id))).toBe(true);
    }
  });

  it('is false for the canvas, the page and no target', () => {
    expect(isEditableTarget(document.getElementById('pane'))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
