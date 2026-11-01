/**
 * `parseCanvasLayout` - the `PUT /agents/:id/layout` body check: one
 * valid layout plus one failing case per rule.
 */
import { describe, it, expect } from 'vitest';
import { parseCanvasLayout } from '../layoutValidation';

const VALID = {
  schemaVersion: 1,
  nodes: {
    agent: { x: 10, y: 20 },
    'tool:web': { x: 300, y: 20, collapsed: true },
  },
  notes: [{ id: 'n1', x: 0, y: 0, text: 'remember this' }],
  viewport: { x: -50, y: 100, zoom: 1.5 },
};

describe('parseCanvasLayout', () => {
  it('accepts a complete valid layout', () => {
    expect(parseCanvasLayout(VALID)).toEqual(VALID);
  });

  it('rejects a schemaVersion other than 1', () => {
    expect(parseCanvasLayout({ ...VALID, schemaVersion: 2 })).toContain('schemaVersion');
    expect(parseCanvasLayout({ ...VALID, schemaVersion: '1' })).toContain('schemaVersion');
  });

  it('rejects nodes that are not a plain object', () => {
    expect(parseCanvasLayout({ ...VALID, nodes: [] })).toContain('nodes');
    expect(parseCanvasLayout({ ...VALID, nodes: 'x' })).toContain('nodes');
  });

  it('rejects more than 2000 nodes', () => {
    const nodes: Record<string, { x: number; y: number }> = {};
    for (let index = 0; index < 2001; index++) nodes[`n${index}`] = { x: 0, y: 0 };
    expect(parseCanvasLayout({ ...VALID, nodes })).toContain('2000');
  });

  it('rejects a node without finite x/y, a non-boolean collapsed or extra keys', () => {
    expect(parseCanvasLayout({ ...VALID, nodes: { a: { x: Number.NaN, y: 1 } } })).toBe(
      "nodes['a'].x must be a finite number"
    );
    expect(parseCanvasLayout({ ...VALID, nodes: { a: { x: 1 } } })).toContain("nodes['a'].y");
    expect(
      parseCanvasLayout({ ...VALID, nodes: { a: { x: 1, y: 1, collapsed: 'yes' } } })
    ).toContain("nodes['a'].collapsed");
    expect(parseCanvasLayout({ ...VALID, nodes: { a: { x: 1, y: 1, label: 'x' } } })).toContain(
      "nodes['a']"
    );
  });

  it('rejects notes that are not an array or that exceed 200 entries', () => {
    expect(parseCanvasLayout({ ...VALID, notes: {} })).toContain('notes');
    const notes = Array.from({ length: 201 }, (_, index) => ({ id: `n${index}`, x: 0, y: 0, text: 't' }));
    expect(parseCanvasLayout({ ...VALID, notes })).toContain('200');
  });

  it('rejects a note with a bad id, non-finite position or oversized text', () => {
    const note = { id: 'n1', x: 0, y: 0, text: 't' };
    expect(parseCanvasLayout({ ...VALID, notes: [{ ...note, id: '' }] })).toContain('notes[0].id');
    expect(parseCanvasLayout({ ...VALID, notes: [{ ...note, id: 'x'.repeat(65) }] })).toContain(
      'notes[0].id'
    );
    expect(parseCanvasLayout({ ...VALID, notes: [{ ...note, x: '0' }] })).toContain('notes[0].x');
    expect(parseCanvasLayout({ ...VALID, notes: [{ ...note, text: 'x'.repeat(2001) }] })).toContain(
      'notes[0].text'
    );
  });

  it('rejects a viewport that is not an object or has non-finite x/y', () => {
    expect(parseCanvasLayout({ ...VALID, viewport: 5 })).toContain('viewport');
    expect(
      parseCanvasLayout({ ...VALID, viewport: { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 } })
    ).toContain('viewport.x');
    expect(parseCanvasLayout({ ...VALID, viewport: { x: 0, zoom: 1 } })).toContain('viewport.y');
  });

  it('rejects a zoom outside [0.05, 4], naming viewport.zoom', () => {
    expect(parseCanvasLayout({ ...VALID, viewport: { x: 0, y: 0, zoom: 9 } })).toContain('viewport.zoom');
    expect(parseCanvasLayout({ ...VALID, viewport: { x: 0, y: 0, zoom: 0.01 } })).toContain(
      'viewport.zoom'
    );
    expect(parseCanvasLayout({ ...VALID, viewport: { x: 0, y: 0, zoom: '1' } })).toContain(
      'viewport.zoom'
    );
  });
});
