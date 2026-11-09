/**
 * A minimal RFC 6902-style JSON patch (C20): the three ops the undo
 * history stores, a structural `diffJson` that turns one JSON value into
 * another, and an immutable `applyPatch` that throws
 * `Error('Patch does not apply: <path>')` on a missing path. Objects diff
 * by key; arrays diff by index — changed indexes are replaced in place and
 * only the tail is added/removed (not minimal, but correct for undo).
 */

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural JSON equality (key order-insensitive), used to skip no-op diffs. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key])
      )
    );
  }
  return false;
}

function escapeSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** JSON Pointer for `segments` ('~' → '~0', '/' → '~1'); the empty list is the document root ''. */
export function pointer(segments: (string | number)[]): string {
  if (segments.length === 0) return '';
  return '/' + segments.map(escapeSegment).join('/');
}

/** The path of `key` under `base` (base '' or a pointer like '/spec/tools'). */
function childPath(base: string, key: string | number): string {
  return base + pointer([key]);
}

function diffObjects(a: Record<string, unknown>, b: Record<string, unknown>, base: string): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const key of Object.keys(a)) {
    const path = childPath(base, key);
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      ops.push({ op: 'remove', path });
    } else {
      ops.push(...diffJson(a[key], b[key], path));
    }
  }
  for (const key of Object.keys(b)) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) {
      ops.push({ op: 'add', path: childPath(base, key), value: b[key] });
    }
  }
  return ops;
}

function diffArrays(a: unknown[], b: unknown[], base: string): PatchOp[] {
  const ops: PatchOp[] = [];
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    ops.push(...diffJson(a[i], b[i], childPath(base, i)));
  }
  // Tail additions append at increasing indexes; tail removals go
  // highest-first so each remove hits the index it was diffed at.
  for (let i = a.length; i < b.length; i++) {
    ops.push({ op: 'add', path: childPath(base, i), value: b[i] });
  }
  for (let i = a.length - 1; i >= b.length; i--) {
    ops.push({ op: 'remove', path: childPath(base, i) });
  }
  return ops;
}

/**
 * The minimal ops turning `a` into `b`. `base` is the JSON Pointer prefix
 * the ops are relative to ('' for the root); nested calls pass the child
 * path. Returns [] when `a` and `b` are structurally equal.
 */
export function diffJson(a: unknown, b: unknown, base = ''): PatchOp[] {
  if (jsonEqual(a, b)) return [];
  if (isRecord(a) && isRecord(b)) return diffObjects(a, b, base);
  if (Array.isArray(a) && Array.isArray(b)) return diffArrays(a, b, base);
  return [{ op: 'replace', path: base, value: b }];
}

/** Splits a pointer into unescaped segments; '' is the root, anything else must start with '/'. */
function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`Patch does not apply: ${path}`);
  return path
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function fail(path: string): never {
  throw new Error(`Patch does not apply: ${path}`);
}

/** Applies one op at `segments` under `node`, returning the new subtree (never mutates). */
function applyAt(node: unknown, segments: string[], op: PatchOp): unknown {
  const [head, ...rest] = segments;
  if (Array.isArray(node)) {
    if (!/^\d+$/.test(head)) fail(op.path);
    const index = Number(head);
    if (rest.length === 0) {
      if (op.op === 'add') {
        if (index > node.length) fail(op.path);
        const next = node.slice();
        next.splice(index, 0, op.value);
        return next;
      }
      if (index >= node.length) fail(op.path);
      const next = node.slice();
      if (op.op === 'remove') next.splice(index, 1);
      else next[index] = op.value;
      return next;
    }
    if (index >= node.length) fail(op.path);
    const child = applyAt(node[index], rest, op);
    const next = node.slice();
    next[index] = child;
    return next;
  }
  if (isRecord(node)) {
    if (rest.length === 0) {
      const exists = Object.prototype.hasOwnProperty.call(node, head);
      if (op.op !== 'add' && !exists) fail(op.path);
      const next = { ...node };
      if (op.op === 'remove') delete next[head];
      else next[head] = op.value;
      return next;
    }
    if (!Object.prototype.hasOwnProperty.call(node, head)) fail(op.path);
    return { ...node, [head]: applyAt(node[head], rest, op) };
  }
  return fail(op.path);
}

function applyOp(doc: unknown, op: PatchOp): unknown {
  const segments = parsePointer(op.path);
  if (segments.length === 0) {
    // The document root: add/replace swap the whole value; remove has no target.
    if (op.op === 'remove') fail(op.path);
    return op.value;
  }
  return applyAt(doc, segments, op);
}

/**
 * Returns a new value with `ops` applied in order; the input is never
 * mutated. Throws `Error('Patch does not apply: <path>')` when a path is
 * missing (or a replace/remove target does not exist).
 */
export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  let current: unknown = doc;
  for (const op of ops) current = applyOp(current, op);
  return current as T;
}
