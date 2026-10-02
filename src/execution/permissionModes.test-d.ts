/**
 * N4: `permissionMode` is accepted by `createAgent()`, `send()` / `stream()`
 * and `agent.session()`, and switched with `session.setPermissionMode()`.
 * The calls sit in functions that are never called: only their types are checked.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { PermissionMode, PermissionModeChange } from '../index';

describe('permissionMode (N4)', () => {
  it('is accepted by createAgent(), as a mode or a function', () => {
    const typeOnly = () => {
      const provider = mockModel(['ok']);
      createAgent({ provider, permissionMode: 'plan' });
      createAgent({ provider, permissionMode: (): PermissionMode => 'acceptEdits' });
      createAgent({ provider, onPermissionModeChange: (change) => expectTypeOf(change).toEqualTypeOf<PermissionModeChange>() });
      // @ts-expect-error - not a permission mode
      createAgent({ provider, permissionMode: 'bypassPermissions' });
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('is accepted by send(), stream() and agent.session()', () => {
    const typeOnly = () => {
      const agent = createAgent({ provider: mockModel(['ok']) });
      void agent.send('hi', { permissionMode: 'dontAsk' });
      void agent.stream('hi', { permissionMode: 'default' });
      // @ts-expect-error - a send() call takes a mode, not a function
      void agent.send('hi', { permissionMode: () => 'plan' });
      const session = agent.session({ permissionMode: 'plan' });
      session.setPermissionMode('acceptEdits');
      expectTypeOf(session.permissionMode).toEqualTypeOf<PermissionMode>();
      // @ts-expect-error - not a permission mode
      session.setPermissionMode('auto');
    };
    expectTypeOf(typeOnly).toBeFunction();
  });

  it('is the union of the four modes', () => {
    expectTypeOf<PermissionMode>().toEqualTypeOf<'default' | 'plan' | 'acceptEdits' | 'dontAsk'>();
  });
});
