/** Eve CORE-F2: a throwing onEvent listener must not fail a run whose side effects already ran. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';

afterEach(() => vi.restoreAllMocks());

describe('onEvent listener isolation (Eve CORE-F2)', () => {
  for (const failOn of ['run.start', 'tool.start', 'tool.done', 'run.done'] as const) {
    it(`a throw on ${failOn} does not reject send() and is reported once`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let sent = 0;
      const sendEmail = defineTool({
        name: 'send_email',
        description: 's',
        input: z.object({}),
        execute: async () => {
          sent++;
          return 'sent';
        },
      });
      const agent = createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'send_email' }] }, 'done']),
        tools: [sendEmail],
        onEvent: (e) => {
          if (e.type === failOn) throw new Error('telemetry bug');
        },
      });
      const result = await agent.send('go');
      expect(result.finishReason).toBe('stop');
      expect(result.text).toBe('done');
      expect(sent).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  }
});
