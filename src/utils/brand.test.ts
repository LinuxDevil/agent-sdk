import { describe, expect, it } from 'vitest';
import { instanceOfBranded } from './brand';

const BRAND = Symbol.for('lousho.test.Base');

class Base {
  static [Symbol.hasInstance](value: unknown): boolean {
    return instanceOfBranded(this, Base, BRAND, value);
  }
}

class Sub extends Base {}

describe('instanceOfBranded', () => {
  const fromOtherCopy = { [BRAND]: true };

  it('accepts a branded value from another copy on the base class', () => {
    expect(fromOtherCopy instanceof Base).toBe(true);
  });

  it('keeps the default check for real instances and unbranded values', () => {
    expect(new Base() instanceof Base).toBe(true);
    expect(new Sub() instanceof Base).toBe(true);
    expect({} instanceof Base).toBe(false);
    expect({ [BRAND]: 'yes' } instanceof Base).toBe(false);
    expect((null as unknown) instanceof Base).toBe(false);
    expect((1 as unknown) instanceof Base).toBe(false);
  });

  it('keeps the default check on a subclass', () => {
    expect(fromOtherCopy instanceof Sub).toBe(false);
    expect(new Sub() instanceof Sub).toBe(true);
    expect(new Base() instanceof Sub).toBe(false);
  });
});
