import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpChannel } from './httpChannel';

describe('httpChannel verify warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns exactly once per channel when no verify is given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    httpChannel();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('[lousho]');
    expect(message).toMatch(/unless the server in front of it checks auth/);
    expect(message).toMatch(/LOUSHO_API_TOKEN/);
    expect(message).not.toMatch(/is unauthenticated/);
    expect(message).toMatch(/sessionKey/);
    expect(message).toMatch(/verify/);
  });

  it('does not warn when verify is given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    httpChannel({ verify: async () => true });
    expect(warn).not.toHaveBeenCalled();
  });
});
