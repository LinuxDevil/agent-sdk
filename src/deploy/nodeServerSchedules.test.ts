/** LOU-P8: the node server runs the schedules of the agent directory it serves. */
import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineSchedule } from '../schedules/defineSchedule';
import { createDeployedServer } from './nodeServer';

describe('node server schedules', () => {
  it('starts them when the server listens and stops them when it closes', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    const cancel = vi.fn();
    const setTimer = vi.fn(() => cancel);
    const { server } = createDeployedServer(agent, {
      env: {},
      schedules: [defineSchedule({ cron: '* * * * *', run: async () => undefined })],
      scheduler: { setTimer },
    });
    expect(setTimer).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    await new Promise((resolve) => server.close(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    await agent.close();
  });
});
