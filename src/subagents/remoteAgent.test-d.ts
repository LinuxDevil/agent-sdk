import { expectTypeOf, test } from 'vitest';
import type { AgentEventUsage } from '../execution/agentEvents';
import type { RemoteRunOptions, RemoteSubagent } from './types';

test('a hand-written RemoteSubagent that ignores onUsage still type-checks (M10b)', () => {
  const handWritten: RemoteSubagent = { description: 'Echoes the task', run: async (prompt) => prompt };
  const withOptions: RemoteSubagent = { description: 'Echoes', run: async (prompt, options) => `${options?.name ?? 'echo'}: ${prompt}` };
  expectTypeOf(handWritten.run).returns.toEqualTypeOf<Promise<string>>();
  expectTypeOf(withOptions.run).parameter(1).toEqualTypeOf<RemoteRunOptions | undefined>();
  expectTypeOf<RemoteRunOptions['onUsage']>().toEqualTypeOf<((usage: AgentEventUsage) => void) | undefined>();
});
