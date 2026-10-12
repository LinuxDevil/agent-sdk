/**
 * Cross-copy `instanceof` for SDK classes (LOU-D42). ESM and CJS builds share chunks, but a process
 * that loads both formats (the dual-package hazard) gets two copies of each class. A class opts in
 * with a registered `Symbol.for` brand on its prototype and a static `Symbol.hasInstance` calling
 * this: instances from any copy pass `instanceof` of the branded base, subclasses keep the default check.
 */
export function instanceOfBranded(cls: object, base: object, brand: symbol, value: unknown): boolean {
  if (cls === base && typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true) {
    return true;
  }
  return Function.prototype[Symbol.hasInstance].call(cls, value);
}

/** Where {@link brandClass} keeps a class's own brand (registered, so every copy reads the same key). */
const CLASS_BRAND = Symbol.for('lousho.classBrand');

/**
 * Brands `cls` as `lousho.<name>`, for a class hierarchy whose root's static
 * `Symbol.hasInstance` calls {@link instanceOfOwnBrand} (as `SDKError` does):
 * `instanceof cls` then holds for an instance of `cls`, or of a subclass, made
 * by another copy of the SDK. A subclass that is not branded itself (a user's)
 * keeps the default check.
 */
export function brandClass(cls: abstract new (...args: never[]) => unknown, name: string): void {
  const brand = Symbol.for(`lousho.${name}`);
  Object.defineProperty(cls, CLASS_BRAND, { value: brand });
  Object.defineProperty(cls.prototype, brand, { get: () => true, configurable: true });
}

/** `value instanceof cls`, also true across SDK copies when `cls` has its own {@link brandClass} brand. */
export function instanceOfOwnBrand(cls: object, value: unknown): boolean {
  const brand = Object.prototype.hasOwnProperty.call(cls, CLASS_BRAND) ? (cls as Record<symbol, symbol>)[CLASS_BRAND] : undefined;
  if (brand !== undefined && typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true) {
    return true;
  }
  return Function.prototype[Symbol.hasInstance].call(cls, value);
}

/**
 * A WeakSet every loaded copy of the SDK in this realm shares, registered on
 * `globalThis` under `Symbol.for(key)`: a brand set by one copy (e.g. the ESM
 * build a user's tool file imports) is seen by another (e.g. the CJS build
 * that loads the agent directory). Use it for module-level "made by
 * defineX()" sets that user values cross copies with.
 */
export function sharedWeakSet(key: string): WeakSet<object> {
  const slot = Symbol.for(key);
  const existing = (globalThis as Record<symbol, unknown>)[slot];
  if (existing instanceof WeakSet) return existing as WeakSet<object>;
  const set = new WeakSet<object>();
  Object.defineProperty(globalThis, slot, { value: set, configurable: false, enumerable: false, writable: false });
  return set;
}
