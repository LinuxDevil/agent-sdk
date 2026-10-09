/**
 * Audit Eve PROV-F1/F2: JSON-Schema shapes that OpenAI and Anthropic strict
 * structured output reject (a 400) or quietly mis-handle, rewritten in the
 * copy sent to the model into shapes both accept, and the model's reply
 * decoded back into the schema's own shape before validation:
 *
 * - `oneOf` (zod's `z.discriminatedUnion`) becomes `anyOf`.
 * - A record (`z.record`: an object with an `additionalProperties` schema and
 *   no properties) becomes an array of `{ key, value }` objects. Claude
 *   answered the record form with `{}` every time (PROV-F2).
 * - A tuple (`z.tuple`: positional `items`/`prefixItems`) becomes an object
 *   with `_0`..`_n` (and `_rest` for a rest element).
 * - A root that is not an object (a root `z.union`, a root record) is
 *   wrapped as `{ result: <schema> }`, since a strict schema's root must be
 *   an object with no `anyOf` next to it.
 */

/** What a rewritten node was. */
type StrictShape = 'root' | 'record' | 'tuple';

/** The nodes of one strict schema that {@link rewriteStrictShapes} rewrote. */
export type StrictShapes = WeakMap<object, StrictShape>;

/** JSON-Schema members that hold a keyed map of subschemas. */
const MAP_MEMBERS = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties']);

/** JSON-Schema members that hold a subschema or a list of them. */
const SUBSCHEMA_MEMBERS = new Set([
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Members a rewritten node keeps (annotations); the rest describe the old shape. */
const KEPT_MEMBERS = ['description', 'title'];

/** How deep {@link decodeStrictValue} follows a value (recursive `$ref`s). */
const MAX_DECODE_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The subschema a local `$ref` (`#`, `#/$defs/x`, ...) points at, else `undefined`. */
export function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

/** Each direct subschema of `node`. */
function* subschemas(node: Record<string, unknown>): Generator<unknown> {
  for (const [member, value] of Object.entries(node)) {
    if (MAP_MEMBERS.has(member) && isRecord(value)) yield* Object.values(value);
    else if (SUBSCHEMA_MEMBERS.has(member)) {
      if (Array.isArray(value)) yield* value;
      else yield value;
    }
  }
}

/** Replaces every member of `node` (in place, so `$ref`s to it still resolve) with `next`, keeping annotations. */
function replaceNode(node: Record<string, unknown>, next: Record<string, unknown>): void {
  const kept = Object.fromEntries(KEPT_MEMBERS.filter((member) => member in node).map((member) => [member, node[member]]));
  for (const member of Object.keys(node)) delete node[member];
  Object.assign(node, next, kept);
}

/** Whether `node` is a record: an object whose values are an `additionalProperties` schema, with no fixed properties. */
function isRecordNode(node: Record<string, unknown>): boolean {
  const type = node.type;
  if (type !== undefined && type !== 'object') return false;
  if (isRecord(node.properties) && Object.keys(node.properties).length > 0) return false;
  return isRecord(node.additionalProperties) || node.additionalProperties === true;
}

/** The positional element schemas of a tuple node, and its rest element schema, else `undefined`. */
function tupleParts(node: Record<string, unknown>): { elements: unknown[]; rest: unknown } | undefined {
  if (node.type !== undefined && node.type !== 'array') return undefined;
  if (Array.isArray(node.prefixItems)) return { elements: node.prefixItems, rest: isRecord(node.items) ? node.items : undefined };
  if (Array.isArray(node.items)) return { elements: node.items, rest: isRecord(node.additionalItems) ? node.additionalItems : undefined };
  return undefined;
}

function closedObject(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** Rewrites `node` and (first) its subschemas in place; `seen` guards shared and cyclic nodes. */
function rewriteNode(node: unknown, shapes: StrictShapes, seen: Set<object>): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteNode(item, shapes, seen);
    return;
  }
  if (!isRecord(node) || seen.has(node)) return;
  seen.add(node);
  for (const sub of subschemas(node)) rewriteNode(sub, shapes, seen);
  if (Array.isArray(node.oneOf)) {
    node.anyOf = Array.isArray(node.anyOf) ? [...node.anyOf, ...node.oneOf] : node.oneOf;
    delete node.oneOf;
  }
  if (isRecordNode(node)) rewriteRecordNode(node, shapes);
  else rewriteTupleNode(node, shapes);
}

/** Rewrites a record node into an array of `{ key, value }` objects. */
function rewriteRecordNode(node: Record<string, unknown>, shapes: StrictShapes): void {
  const key = isRecord(node.propertyNames) ? { type: 'string', ...node.propertyNames } : { type: 'string' };
  const value = node.additionalProperties === true ? {} : node.additionalProperties;
  replaceNode(node, { type: 'array', items: closedObject({ key, value }) });
  shapes.set(node, 'record');
}

/** Rewrites a tuple node (if `node` is one) into an object with `_0`..`_n` (and `_rest`). */
function rewriteTupleNode(node: Record<string, unknown>, shapes: StrictShapes): void {
  const tuple = tupleParts(node);
  if (!tuple) return;
  const properties: Record<string, unknown> = Object.fromEntries(tuple.elements.map((element, index) => [`_${index}`, element]));
  if (tuple.rest) properties._rest = { type: 'array', items: tuple.rest };
  replaceNode(node, closedObject(properties));
  shapes.set(node, 'tuple');
}

/** Members a wrapped root keeps at the root: what `$ref`s point into, and the dialect. */
const ROOT_MEMBERS = new Set(['$schema', '$defs', 'definitions', '$id']);

/** Points each `$ref` into the old root (`#`, `#/properties/...`) at `#/properties/result`. */
function retargetRootRefs(node: unknown, seen: Set<object> = new Set()): void {
  if (typeof node !== 'object' || node === null || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) retargetRootRefs(item, seen);
    return;
  }
  const schema = node as Record<string, unknown>;
  const ref = schema.$ref;
  if (typeof ref === 'string' && (ref === '#' || ref.startsWith('#/')) && !/^#\/(\$defs|definitions)(\/|$)/.test(ref)) {
    schema.$ref = `#/properties/result${ref.slice(1)}`;
  }
  for (const value of Object.values(schema)) retargetRootRefs(value, seen);
}

/** Wraps a root that is not an object (a union, a rewritten record, a scalar) as `{ result: <root> }`. */
function wrapRoot(root: Record<string, unknown>, shapes: StrictShapes): void {
  const objectRoot = root.type === 'object' || (root.type === undefined && isRecord(root.properties));
  if (objectRoot && !Array.isArray(root.anyOf) && !Array.isArray(root.allOf)) return;
  const inner: Record<string, unknown> = {};
  for (const [member, value] of Object.entries(root)) {
    if (!ROOT_MEMBERS.has(member)) {
      inner[member] = value;
      delete root[member];
    }
  }
  retargetRootRefs([inner, root.$defs, root.definitions]);
  const shape = shapes.get(root);
  if (shape) shapes.set(inner, shape);
  Object.assign(root, closedObject({ result: inner }));
  shapes.set(root, 'root');
}

/**
 * Rewrites `strict` (the copy sent to the model, objects already closed) in
 * place into shapes strict structured output accepts; the result says which
 * nodes changed, for {@link decodeStrictValue}.
 */
export function rewriteStrictShapes(strict: Record<string, unknown>): StrictShapes {
  const shapes: StrictShapes = new WeakMap();
  rewriteNode(strict, shapes, new Set());
  wrapRoot(strict, shapes);
  return shapes;
}

/** Whether `value` has the JSON type `type` names. */
function hasType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => hasType(value, item));
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    default:
      return true;
  }
}

/** Whether `value` plausibly is an instance of `node` (a subschema of `root`): types, object keys and `const`/`enum` members. */
function fits(value: unknown, node: unknown, root: unknown, depth = 0): boolean {
  if (!isRecord(node) || depth > MAX_DECODE_DEPTH) return true;
  if (typeof node.$ref === 'string') return fits(value, resolveRef(root, node.$ref), root, depth + 1);
  if (Array.isArray(node.anyOf)) return node.anyOf.some((branch) => fits(value, branch, root, depth + 1));
  if ('const' in node) return node.const === value;
  if (Array.isArray(node.enum)) return node.enum.includes(value);
  if (!hasType(value, node.type)) return false;
  if (!isRecord(value) || !isRecord(node.properties)) return true;
  const properties = node.properties;
  const required = Array.isArray(node.required) ? node.required : [];
  return (
    required.every((key) => typeof key === 'string' && key in value) &&
    Object.keys(value).every((key) => Object.hasOwn(properties, key) || node.additionalProperties !== false) &&
    Object.entries(properties).every(([key, sub]) => !(key in value) || !isRecord(sub) || !('const' in sub || 'enum' in sub) || fits(value[key], sub, root, depth + 1))
  );
}

/**
 * `value` (the model's parsed reply, an instance of the strict schema) in the
 * schema's own shape: a wrapped root unwrapped, `{ key, value }` arrays back
 * to records, `_0`..`_n` objects back to tuples. A part that does not have
 * the rewritten shape (a model that answered in the original one) is left as
 * it is. Returns a new value; `value` is not changed.
 */
export function decodeStrictValue(value: unknown, node: unknown, root: unknown, shapes: StrictShapes, depth = 0): unknown {
  if (!isRecord(node) || depth > MAX_DECODE_DEPTH) return value;
  const next: DecodeNext = (item, sub) => decodeStrictValue(item, sub, root, shapes, depth + 1);
  if (typeof node.$ref === 'string') return next(value, resolveRef(root, node.$ref));
  const shape = shapes.get(node);
  const properties = isRecord(node.properties) ? node.properties : {};
  if (shape) return SHAPE_DECODERS[shape](value, node, properties, next);
  if (Array.isArray(node.anyOf)) {
    const branch = node.anyOf.find((item) => fits(value, item, root));
    return branch === undefined ? value : next(value, branch);
  }
  return decodePlain(value, node, properties, next);
}

/** Decodes `item` as an instance of the subschema `sub`, one level deeper. */
type DecodeNext = (item: unknown, sub: unknown) => unknown;

/** Decodes `value` against `node` (with its `properties`), recursing through `next`. */
type ShapeDecoder = (value: unknown, node: Record<string, unknown>, properties: Record<string, unknown>, next: DecodeNext) => unknown;

/** A wrapped root `{ result }` unwrapped. */
const decodeRoot: ShapeDecoder = (value, _node, properties, next) =>
  isRecord(value) && Object.keys(value).length === 1 && 'result' in value ? next(value.result, properties.result) : value;

/** `{ key, value }` entries back to a record. */
const decodeRecord: ShapeDecoder = (value, node, _properties, next) => {
  if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && 'key' in entry)) return value;
  const valueSchema = isRecord(node.items) && isRecord(node.items.properties) ? node.items.properties.value : undefined;
  return Object.fromEntries(value.map((entry) => [String(entry.key), next(entry.value, valueSchema)]));
};

/** An `_0`..`_n` (and `_rest`) object back to a tuple. */
const decodeTuple: ShapeDecoder = (value, _node, properties, next) => {
  if (!isRecord(value)) return value;
  const elements = Object.keys(properties)
    .filter((key) => /^_\d+$/.test(key))
    .map((key) => next(value[key], properties[key]));
  const rest = Array.isArray(value._rest) ? value._rest.map((item) => next(item, (properties._rest as Record<string, unknown> | undefined)?.items)) : [];
  return [...elements, ...rest];
};

/** The decoder for each rewritten shape. */
const SHAPE_DECODERS: Record<StrictShape, ShapeDecoder> = { root: decodeRoot, record: decodeRecord, tuple: decodeTuple };

/** A node that was not rewritten: its array items or object members decoded. */
const decodePlain: ShapeDecoder = (value, node, properties, next) => {
  if (Array.isArray(value)) return isRecord(node.items) ? value.map((item) => next(item, node.items)) : value;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, next(item, Object.hasOwn(properties, key) ? properties[key] : node.additionalProperties)])
    );
  }
  return value;
};
