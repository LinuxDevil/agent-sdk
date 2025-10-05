import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptionUtils, generatePassword, DTOEncryptionFilter, sha256 } from './crypto';

describe('Security - Crypto', () => {
  describe('EncryptionUtils', () => {
    let encryptionUtils: EncryptionUtils;
    const testSecret = 'test-secret-key-12345';

    beforeEach(() => {
      encryptionUtils = new EncryptionUtils(testSecret);
    });

    it('should encrypt and decrypt text', async () => {
      const originalText = 'Hello, World!';
      const encrypted = await encryptionUtils.encrypt(originalText);
      const decrypted = await encryptionUtils.decrypt(encrypted);

      expect(encrypted).not.toBe(originalText);
      expect(decrypted).toBe(originalText);
    });

    it('should handle empty strings', async () => {
      const encrypted = await encryptionUtils.encrypt('');
      const decrypted = await encryptionUtils.decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('should handle special characters', async () => {
      const specialText = '!@#$%^&*(){}[]<>?/\\|~`';
      const encrypted = await encryptionUtils.encrypt(specialText);
      const decrypted = await encryptionUtils.decrypt(encrypted);
      expect(decrypted).toBe(specialText);
    });

    it('should handle unicode characters', async () => {
      const unicodeText = '你好世界 🌍 مرحبا بالعالم';
      const encrypted = await encryptionUtils.encrypt(unicodeText);
      const decrypted = await encryptionUtils.decrypt(encrypted);
      expect(decrypted).toBe(unicodeText);
    });

    it('should produce different ciphertexts for same plaintext', async () => {
      const text = 'test';
      const encrypted1 = await encryptionUtils.encrypt(text);
      const encrypted2 = await encryptionUtils.encrypt(text);
      // Due to random IV, encryptions should be different
      expect(encrypted1).not.toBe(encrypted2);
      // But both should decrypt to the same value
      expect(await encryptionUtils.decrypt(encrypted1)).toBe(text);
      expect(await encryptionUtils.decrypt(encrypted2)).toBe(text);
    });

    it('should return original text on decrypt failure', async () => {
      const invalidCiphertext = 'invalid-ciphertext';
      const result = await encryptionUtils.decrypt(invalidCiphertext);
      expect(result).toBe(invalidCiphertext);
    });
  });

  describe('generatePassword', () => {
    it('should generate a password', () => {
      const password = generatePassword();
      expect(password).toBeDefined();
      expect(typeof password).toBe('string');
      expect(password.length).toBeGreaterThan(0);
    });

    it('should generate different passwords', () => {
      const password1 = generatePassword();
      const password2 = generatePassword();
      expect(password1).not.toBe(password2);
    });

    it('should generate base64 encoded passwords', () => {
      const password = generatePassword();
      // Base64 should only contain these characters
      expect(password).toMatch(/^[A-Za-z0-9+/=]+$/);
    });
  });

  describe('DTOEncryptionFilter', () => {
    let filter: DTOEncryptionFilter<any>;
    const testSecret = 'test-secret-key-12345';

    beforeEach(() => {
      filter = new DTOEncryptionFilter(testSecret);
    });

    it('should encrypt and decrypt string fields', async () => {
      const dto = { name: 'John', age: 30, email: 'john@example.com' };
      const encrypted = await filter.encrypt(dto);
      const decrypted = await filter.decrypt(encrypted);

      expect(encrypted.name).not.toBe(dto.name);
      expect(decrypted.name).toBe(dto.name);
      expect(decrypted.email).toBe(dto.email);
    });

    it('should encrypt only specified fields when settings provided', async () => {
      const dto = { name: 'John', age: 30, email: 'john@example.com' };
      const settings = { encryptedFields: ['email'] };

      const encrypted = await filter.encrypt(dto, settings);

      expect(encrypted.name).toBe(dto.name); // Not encrypted
      expect(encrypted.email).not.toBe(dto.email); // Encrypted
      expect(encrypted.age).toBe(dto.age); // Not encrypted

      const decrypted = await filter.decrypt(encrypted, settings);
      expect(decrypted).toEqual(dto);
    });

    it('should handle object fields', async () => {
      const dto = {
        user: { name: 'John', details: { age: 30 } },
        simple: 'text',
      };
      const encrypted = await filter.encrypt(dto);
      const decrypted = await filter.decrypt(encrypted);

      expect(decrypted).toEqual(dto);
    });

    it('should handle Date objects', async () => {
      const now = new Date();
      const dto = { timestamp: now, name: 'Test' };
      const encrypted = await filter.encrypt(dto);
      const decrypted = await filter.decrypt(encrypted);

      // Date is converted to ISO string during encryption
      expect(decrypted.timestamp).toBe(now.toISOString());
    });
  });

  describe('sha256', () => {
    it('should generate hash', async () => {
      const hash = await sha256('password', 'salt123');
      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 produces 64 hex characters
    });

    it('should generate same hash for same input', async () => {
      const hash1 = await sha256('password', 'salt123');
      const hash2 = await sha256('password', 'salt123');
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different inputs', async () => {
      const hash1 = await sha256('password1', 'salt123');
      const hash2 = await sha256('password2', 'salt123');
      expect(hash1).not.toBe(hash2);
    });

    it('should generate different hashes for different salts', async () => {
      const hash1 = await sha256('password', 'salt1');
      const hash2 = await sha256('password', 'salt2');
      expect(hash1).not.toBe(hash2);
    });

    it('should only contain hex characters', async () => {
      const hash = await sha256('test', 'salt');
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });
});
