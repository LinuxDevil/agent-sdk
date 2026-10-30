import { describe, it, expect } from 'vitest';
import { ConfigurationError } from '../../../execution/errors';
import { resolveSecretRef, resolveStringOrSecret, type SecretHost } from './secrets';

const FIELD = 'f';

async function catchError(promise: Promise<string>): Promise<ConfigurationError> {
  try {
    await promise;
  } catch (error) {
    return error as ConfigurationError;
  }
  throw new Error('expected rejection');
}

describe('resolveSecretRef { env }', () => {
  it('reads host.env first', async () => {
    await expect(resolveSecretRef({ env: 'X' }, { env: { X: 'v' } }, FIELD)).resolves.toBe('v');
  });

  it('falls back to the process env when host.env is absent', async () => {
    process.env.LOUSHO_TEST_SECRET_REF = 'p';
    try {
      await expect(resolveSecretRef({ env: 'LOUSHO_TEST_SECRET_REF' }, {}, FIELD)).resolves.toBe('p');
    } finally {
      delete process.env.LOUSHO_TEST_SECRET_REF;
    }
  });

  it('throws LOUSHO_SPEC_SECRET_MISSING naming the field when the variable is unset', async () => {
    const error = await catchError(resolveSecretRef({ env: 'X' }, { env: {} }, FIELD));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
    expect(error.field).toBe(FIELD);
    expect(error.detail).toBe("AgentSpec v2: 'f' needs the environment variable X, which is not set.");
  });

  it('treats an empty value as missing', async () => {
    const error = await catchError(resolveSecretRef({ env: 'X' }, { env: { X: '' } }, FIELD));
    expect(error.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
  });
});

describe('resolveSecretRef { secret }', () => {
  it('asks host.resolveSecret (async or sync)', async () => {
    const asyncHost: SecretHost = { resolveSecret: async () => 'v' };
    await expect(resolveSecretRef({ secret: 's' }, asyncHost, FIELD)).resolves.toBe('v');
    const syncHost: SecretHost = { resolveSecret: () => 'v' };
    await expect(resolveSecretRef({ secret: 's' }, syncHost, FIELD)).resolves.toBe('v');
  });

  it('reports a host with no secret store', async () => {
    const error = await catchError(resolveSecretRef({ secret: 's' }, {}, FIELD));
    expect(error.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
    expect(error.field).toBe(FIELD);
    expect(error.detail).toBe("AgentSpec v2: 'f' needs the secret 's', but this host has no secret store.");
  });

  it('reports a secret the store does not have', async () => {
    const error = await catchError(resolveSecretRef({ secret: 's' }, { resolveSecret: () => undefined }, FIELD));
    expect(error.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
    expect(error.detail).toBe("AgentSpec v2: 'f' needs the secret 's', which is not set. Add it in Settings → Secrets.");
  });
});

describe('resolveStringOrSecret', () => {
  it('passes plain strings through', async () => {
    await expect(resolveStringOrSecret('plain', {}, FIELD)).resolves.toBe('plain');
  });

  it('resolves refs through resolveSecretRef', async () => {
    await expect(resolveStringOrSecret({ env: 'X' }, { env: { X: 'v' } }, FIELD)).resolves.toBe('v');
  });
});
