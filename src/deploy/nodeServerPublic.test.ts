/** The built server's start-up check: no open agent on a public interface unless LOUSHO_ALLOW_PUBLIC=1. */
import { describe, expect, it } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { SDKError } from '../utils/sdkError';
import { checkServerExposure, createDeployedServer, type DeployedServerOptions } from './nodeServer';

/** `authenticated` of a deployed server built with `options`. */
function authenticatedWith(options: DeployedServerOptions): boolean {
  const agent = createAgent({ provider: mockModel(['ok']), instructions: 'x' });
  return createDeployedServer(agent, options).authenticated;
}

function refusal(run: () => unknown): SDKError {
  try {
    run();
  } catch (error) {
    if (error instanceof SDKError) return error;
    throw error;
  }
  throw new Error('expected checkServerExposure() to throw');
}

describe('checkServerExposure()', () => {
  it('refuses 0.0.0.0 with no auth (LOUSHO_SERVER_UNPROTECTED), naming every way out', () => {
    const error = refusal(() => checkServerExposure('0.0.0.0', authenticatedWith({ env: {} }), {}));
    expect(error.code).toBe('LOUSHO_SERVER_UNPROTECTED');
    for (const fix of ['LOUSHO_API_TOKEN', 'auth.ts', '127.0.0.1', 'LOUSHO_ALLOW_PUBLIC=1']) expect(error.message).toContain(fix);
  });

  it.each(['::', '192.168.1.20', 'example.com', '128.0.0.1'])('refuses %s with no auth too', (host) => {
    expect(refusal(() => checkServerExposure(host, false, {})).code).toBe('LOUSHO_SERVER_UNPROTECTED');
  });

  it('starts on 0.0.0.0 when LOUSHO_API_TOKEN is set', () => {
    const env = { LOUSHO_API_TOKEN: 's3cret' };
    expect(checkServerExposure('0.0.0.0', authenticatedWith({ env }), env)).toBeUndefined();
  });

  it('starts on 0.0.0.0 with an auth list (an agent directory auth.ts) and no token', () => {
    const allowAll = async () => ({ id: 'anyone', type: 'user' as const, authenticator: 'custom' });
    expect(checkServerExposure('0.0.0.0', authenticatedWith({ env: {}, auth: [allowAll] }), {})).toBeUndefined();
  });

  it.each(['1', 'true'])('starts on 0.0.0.0 with LOUSHO_ALLOW_PUBLIC=%s, returning the open-agent warning', (value) => {
    expect(checkServerExposure('0.0.0.0', false, { LOUSHO_ALLOW_PUBLIC: value })).toBe(
      '[lousho server] warning: no LOUSHO_API_TOKEN set, so anyone who can reach 0.0.0.0 can use this agent.'
    );
  });

  it('does not take LOUSHO_ALLOW_PUBLIC=0 as an opt-out', () => {
    expect(refusal(() => checkServerExposure('0.0.0.0', false, { LOUSHO_ALLOW_PUBLIC: '0' })).code).toBe('LOUSHO_SERVER_UNPROTECTED');
  });

  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])('starts on loopback %s with no auth and no warning', (host) => {
    expect(checkServerExposure(host, authenticatedWith({ env: {} }), {})).toBeUndefined();
  });
});
