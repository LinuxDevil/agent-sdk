/**
 * N14: the `codeMode` option of createAgent(). The calls sit in a function
 * that is never called: only their types are checked.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { CodeModeOptions } from '../index';

describe('codeMode (N14)', () => {
  it('takes true, false or CodeModeOptions; unknown keys fail', () => {
    const typeOnly = () => {
      const provider = mockModel(['ok']);
      createAgent({ provider, codeMode: { tools: ['x'], timeoutMs: 1000 } });
      createAgent({ provider, codeMode: true });
      createAgent({ provider, codeMode: { exclusive: true, memoryLimitBytes: 1 << 20, maxToolCalls: 5, maxOutputChars: 100 } });
      // @ts-expect-error - not an option of codeMode
      createAgent({ provider, codeMode: { timeout: 1000 } });
      // @ts-expect-error - tools is a list of names
      createAgent({ provider, codeMode: { tools: 'x' } });
      // @ts-expect-error - a number is not a codeMode setting
      createAgent({ provider, codeMode: 1 });
    };
    expectTypeOf(typeOnly).toBeFunction();
    expectTypeOf<CodeModeOptions['timeoutMs']>().toEqualTypeOf<number | undefined>();
  });
});
