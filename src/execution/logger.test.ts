import { describe, it, expect, vi } from 'vitest';
import { noopLogger } from './logger';

describe('noopLogger', () => {
  it('calling all four methods does not throw', () => {
    expect(() => {
      noopLogger.debug('debug message', { a: 1 });
      noopLogger.info('info message');
      noopLogger.warn('warn message', { b: 2 });
      noopLogger.error('error message', { c: 3 });
    }).not.toThrow();
  });

  it('never calls console.log itself', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    noopLogger.debug('debug message');
    noopLogger.info('info message');
    noopLogger.warn('warn message');
    noopLogger.error('error message');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
