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
