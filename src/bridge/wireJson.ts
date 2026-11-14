/**
 * The bridge's one JSON serializer (W10a): `JSON.stringify` semantics plus
 * the wire extras the protocol needs — `Error` becomes `{ name, message,
 * code? }`, `bigint` a string, `Uint8Array` base64, and a reference that
 * would recurse becomes the string `'[Circular]'`. The cycle check is
 * path-based: the same object reached twice through different branches
 * still serializes twice (a WeakMap of holder → value's parent answers
 * "is this value one of my ancestors?" on every replacer call).
 */

/** Serializes `value` for one protocol line; `undefined` (a bare function/symbol top-level) becomes `'null'`. */
export function toWireJson(value: unknown): string {
  const parents = new WeakMap<object, object>();
  // fallow-ignore-next-line complexity
  const json = JSON.stringify(value, function (this: unknown, _key: string, val: unknown) {
    if (typeof val === 'bigint') return val.toString();
    if (val instanceof Uint8Array) {
      return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64');
    }
    if (val instanceof Error) {
      const code = (val as { code?: unknown }).code;
      return { name: val.name, message: val.message, ...(code !== undefined ? { code } : {}) };
    }
    if (val === null || typeof val !== 'object') return val;
    // `this` is the holder being serialized; its own parent link was recorded
    // when the holder itself passed through the replacer.
    for (let cur = this as object | undefined; cur !== undefined; cur = parents.get(cur)) {
      if (cur === val) return '[Circular]';
    }
    parents.set(val, this as object);
    return val;
  });
  return json ?? 'null';
}
