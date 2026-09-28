import { describe, it, expect, vi } from 'vitest';
import { handleErrorSignal, buildMonitorPrompt, ErrorSignal, startMonitorServer } from './monitor';
import { AgentExecutor } from '../../src/execution/AgentExecutor';
import { AgentType } from '../../src/types';
import { createMockProvider } from '../../src/providers/mock';

function makeSignal(overrides: Partial<ErrorSignal> = {}): ErrorSignal {
  return {
    signature: 'sig-1',
    service: 'grafana',
    message: 'NullPointerException in OrderService',
    logs: 'at OrderService.charge(OrderService.java:42)',
    ...overrides,
  };
}

const executeOptions = {
  agent: { name: 'monitor', agentType: AgentType.SmartAssistant, prompt: 'You are the monitor.' },
  provider: createMockProvider({ responses: ['ack'] }),
};

describe('buildMonitorPrompt', () => {
  it('includes the signature, message and logs', () => {
    const prompt = buildMonitorPrompt(makeSignal());
    expect(prompt).toContain('sig-1');
    expect(prompt).toContain('NullPointerException in OrderService');
    expect(prompt).toContain('OrderService.java:42');
  });
});

describe('handleErrorSignal', () => {
  it('calls AgentExecutor.execute() exactly once for a new signature', async () => {
    const spy = vi.spyOn(AgentExecutor, 'execute');
    const seen = new Set<string>();

    const result = await handleErrorSignal(makeSignal(), executeOptions, seen);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(spy.mock.calls[0][0].input).toContain('sig-1');

    spy.mockRestore();
  });

  it('does not call the executor again for a duplicate signature', async () => {
    const spy = vi.spyOn(AgentExecutor, 'execute');
    const seen = new Set<string>();

    await handleErrorSignal(makeSignal(), executeOptions, seen);
    expect(spy).toHaveBeenCalledTimes(1);

    const secondResult = await handleErrorSignal(makeSignal(), executeOptions, seen);
    expect(spy).toHaveBeenCalledTimes(1); // zero additional calls
    expect(secondResult).toBeUndefined();

    spy.mockRestore();
  });

  it('treats different signatures as independent (executor called once each)', async () => {
    const spy = vi.spyOn(AgentExecutor, 'execute');
    const seen = new Set<string>();

    await handleErrorSignal(makeSignal({ signature: 'sig-a' }), executeOptions, seen);
    await handleErrorSignal(makeSignal({ signature: 'sig-b' }), executeOptions, seen);

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('startMonitorServer', () => {
  it('accepts a POST /webhook and dedupes by signature over HTTP', async () => {
    const spy = vi.spyOn(AgentExecutor, 'execute');
    const seen = new Set<string>();
    const handle = await startMonitorServer({ executeOptions, seen, port: 0 });

    try {
      const url = `http://127.0.0.1:${handle.port}/webhook`;
      const signal = makeSignal({ signature: 'http-sig' });

      const res1 = await fetch(url, { method: 'POST', body: JSON.stringify(signal) });
      const body1 = await res1.json();
      expect(res1.status).toBe(202);
      expect(body1.deduped).toBe(false);

      const res2 = await fetch(url, { method: 'POST', body: JSON.stringify(signal) });
      const body2 = await res2.json();
      expect(body2.deduped).toBe(true);

      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      await handle.close();
    }
  });
});
