import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SecretsStore, maskKey, isSecretProvider } from './secretsStore';

describe('SecretsStore', () => {
  let baseDir: string;
  let store: SecretsStore;

  const savedEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-secrets-'));
    store = new SecretsStore(baseDir);
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('reports no key stored for a fresh provider', () => {
    const status = store.list();
    expect(status).toEqual([
      { provider: 'openai', hasKey: false, masked: null, envKey: false },
      { provider: 'anthropic', hasKey: false, masked: null, envKey: false },
    ]);
  });

  it('reports envKey from the provider env var, independent of a stored key', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key-placeholder';
    expect(store.list().map((s) => [s.provider, s.hasKey, s.envKey])).toEqual([
      ['openai', false, false],
      ['anthropic', false, true],
    ]);
  });

  it('stores and retrieves a key, round-tripping the exact value', () => {
    store.setKey('openai', 'sk-test-abc123XYZ');
    expect(store.getKey('openai')).toBe('sk-test-abc123XYZ');
  });

  it('masks the stored key rather than exposing it in list()', () => {
    store.setKey('openai', 'sk-test-abc123XYZ');
    const status = store.list().find((s) => s.provider === 'openai');
    expect(status?.hasKey).toBe(true);
    expect(status?.masked).toBe(maskKey('sk-test-abc123XYZ'));
    expect(status?.masked).not.toContain('sk-test-abc123XYZ');
    expect(status?.masked).toBe('••••••••3XYZ');
  });

  it('removes a stored key', () => {
    store.setKey('anthropic', 'sk-ant-1234');
    store.removeKey('anthropic');
    expect(store.getKey('anthropic')).toBeUndefined();
    expect(store.list().find((s) => s.provider === 'anthropic')?.hasKey).toBe(false);
  });

  it('removeKey is a no-op for a provider with no stored key', () => {
    expect(() => store.removeKey('openai')).not.toThrow();
  });

  it('rejects an empty key', () => {
    expect(() => store.setKey('openai', '')).toThrow();
    expect(() => store.setKey('openai', '   ')).toThrow();
  });

  it('writes ciphertext, not the plaintext key, to secrets.json', () => {
    store.setKey('openai', 'sk-super-secret-value');
    const raw = fs.readFileSync(path.join(baseDir, '.lousho', 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-super-secret-value');
  });

  it('keeps the encryption key in a separate file from the ciphertext', () => {
    store.setKey('openai', 'sk-abc');
    expect(fs.existsSync(path.join(baseDir, '.lousho', 'secrets.key'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, '.lousho', 'secrets.json'))).toBe(true);
  });

  it('a second store instance (simulating a server restart) can decrypt keys the first instance wrote', () => {
    store.setKey('anthropic', 'sk-ant-restart-test');
    const restarted = new SecretsStore(baseDir);
    expect(restarted.getKey('anthropic')).toBe('sk-ant-restart-test');
  });

  it('getKey returns undefined (not a throw) for a corrupted secrets file', () => {
    store.setKey('openai', 'sk-abc');
    fs.writeFileSync(path.join(baseDir, '.lousho', 'secrets.json'), 'not json', 'utf8');
    expect(store.getKey('openai')).toBeUndefined();
    expect(() => store.list()).not.toThrow();
  });

  it('writes to the given files when constructed with a paths object instead of a baseDir', () => {
    const paths = {
      secrets: path.join(baseDir, 'custom-home', 'secrets.json'),
      secretsKey: path.join(baseDir, 'custom-home', 'secrets.key'),
    };
    const fromPaths = new SecretsStore(paths);
    fromPaths.setKey('openai', 'sk-paths-form');
    expect(fs.existsSync(paths.secrets)).toBe(true);
    expect(fs.existsSync(paths.secretsKey)).toBe(true);
    expect(fromPaths.getKey('openai')).toBe('sk-paths-form');
  });

  it('isSecretProvider narrows only the managed providers', () => {
    expect(isSecretProvider('openai')).toBe(true);
    expect(isSecretProvider('anthropic')).toBe(true);
    expect(isSecretProvider('ollama')).toBe(false);
    expect(isSecretProvider('nonsense')).toBe(false);
  });
});
