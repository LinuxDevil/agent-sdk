/**
 * Canvas layout validation - the `PUT /agents/:id/layout` body check.
 *
 * `layout.json` is presentation state (node positions, sticky notes, the
 * last viewport) the spec deliberately does not carry; the checks here
 * keep it a bounded, well-formed document so a corrupt PUT can never
 * plant a giant or malformed file next to the spec. `parseCanvasLayout`
 * answers the layout itself or the first problem as a sentence (the
 * `LOUSHO_LAYOUT_INVALID` error message).
 */
import type { CanvasLayout } from '../../shared/wireTypes';

const MAX_NODES = 2000;
const MAX_NOTES = 200;
const NOTE_ID_MAX = 64;
const NOTE_TEXT_MAX = 2000;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

/** Every key a `nodes[id]` entry may carry. */
const NODE_KEYS = new Set(['x', 'y', 'collapsed']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The first problem with one `nodes[id]` entry, or `undefined`. */
function nodeProblem(id: string, node: unknown): string | undefined {
  if (!isObject(node)) return `nodes['${id}'] must be an object`;
  if (!isFiniteNumber(node.x)) return `nodes['${id}'].x must be a finite number`;
  if (!isFiniteNumber(node.y)) return `nodes['${id}'].y must be a finite number`;
  if (node.collapsed !== undefined && typeof node.collapsed !== 'boolean') {
    return `nodes['${id}'].collapsed must be a boolean`;
  }
  const extra = Object.keys(node).find((key) => !NODE_KEYS.has(key));
  if (extra !== undefined) return `nodes['${id}'] must only have x, y and optional collapsed`;
  return undefined;
}

/** The first problem with one `notes[i]` entry, or `undefined`. */
function noteProblem(index: number, note: unknown): string | undefined {
  if (!isObject(note)) return `notes[${index}] must be an object`;
  if (typeof note.id !== 'string' || note.id.length < 1 || note.id.length > NOTE_ID_MAX) {
    return `notes[${index}].id must be a string of 1-${NOTE_ID_MAX} characters`;
  }
  if (!isFiniteNumber(note.x)) return `notes[${index}].x must be a finite number`;
  if (!isFiniteNumber(note.y)) return `notes[${index}].y must be a finite number`;
  if (typeof note.text !== 'string' || note.text.length > NOTE_TEXT_MAX) {
    return `notes[${index}].text must be a string of at most ${NOTE_TEXT_MAX} characters`;
  }
  return undefined;
}

/** The first problem with the optional `viewport`, or `undefined`. */
function viewportProblem(viewport: unknown): string | undefined {
  if (!isObject(viewport)) return 'viewport must be an object';
  if (!isFiniteNumber(viewport.x)) return 'viewport.x must be a finite number';
  if (!isFiniteNumber(viewport.y)) return 'viewport.y must be a finite number';
  if (!isFiniteNumber(viewport.zoom)) return 'viewport.zoom must be a finite number';
  if (viewport.zoom < MIN_ZOOM || viewport.zoom > MAX_ZOOM) {
    return `viewport.zoom must be between ${MIN_ZOOM} and ${MAX_ZOOM}`;
  }
  return undefined;
}

/**
 * `body` as a `CanvasLayout`, or the first validation problem as a
 * sentence like `"nodes['agent'].x must be a finite number"` - the route
 * sends it as the `LOUSHO_LAYOUT_INVALID` error.
 */
export function parseCanvasLayout(body: unknown): CanvasLayout | string {
  if (!isObject(body)) return 'Layout must be an object';
  if (body.schemaVersion !== 1) return 'schemaVersion must be 1';
  if (!isObject(body.nodes)) return 'nodes must be an object';
  const nodeEntries = Object.entries(body.nodes);
  if (nodeEntries.length > MAX_NODES) return `nodes must have at most ${MAX_NODES} entries`;
  for (const [id, node] of nodeEntries) {
    const problem = nodeProblem(id, node);
    if (problem !== undefined) return problem;
  }
  if (!Array.isArray(body.notes)) return 'notes must be an array';
  if (body.notes.length > MAX_NOTES) return `notes must have at most ${MAX_NOTES} entries`;
  for (const [index, note] of body.notes.entries()) {
    const problem = noteProblem(index, note);
    if (problem !== undefined) return problem;
  }
  if (body.viewport !== undefined) {
    const problem = viewportProblem(body.viewport);
    if (problem !== undefined) return problem;
  }
  return body as unknown as CanvasLayout;
}
